/**
 * ARI event stream.
 *
 * Asterisk pushes every Stasis event for our application down a single
 * WebSocket. That socket is the heartbeat of the AI voice layer: if it is
 * down, no inbound call is ever noticed. So the connection is treated as
 * permanent and reconnected forever with exponential backoff plus full jitter
 * (500 ms doubling to a 30 s cap), which is what stops a restarted Asterisk
 * from being hammered by an instant retry loop.
 *
 * Uses Bun's global WebSocket - no `ws` package, per the project's Bun-first
 * rule.
 */
import pino from "pino";
import pretty from "pino-pretty";
import type { AriEvent, AriEventName, AriEventOf } from "@/lib/telephony/contracts";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "asterisk:ari-events",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

const DEFAULT_ARI_URL = "http://localhost:8088/ari";
const DEFAULT_ARI_APP = "callcenter-ai";
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/**
 * Full jitter can pick a delay of ~0 ms. Against a refused port that becomes a
 * hot loop, so the drawn delay is floored.
 */
const MIN_BACKOFF_MS = 100;

export type AriEventHandler<TName extends AriEventName> = (event: AriEventOf<TName>) => void;
export type AriAnyEventHandler = (event: AriEvent) => void;
export type AriDisconnectInfo = { code: number; reason: string };

export interface AriEventStreamOptions {
	/** Defaults to ASTERISK_ARI_WS_URL, else derived from ASTERISK_ARI_URL. */
	url?: string;
	/** Stasis application to subscribe to. Defaults to ASTERISK_ARI_APP. */
	app?: string;
	username?: string;
	password?: string;
	/** subscribeAll=true gets bridge and playback events too, not just channels in Stasis. */
	subscribeAll?: boolean;
	initialBackoffMs?: number;
	maxBackoffMs?: number;
	onConnected?: () => void;
	onDisconnected?: (info: AriDisconnectInfo) => void;
}

/** http://host:8088/ari -> ws://host:8088/ari/events */
function deriveWsUrl(ariUrl: string): string {
	const url = new URL(ariUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/events`;
	url.search = "";
	return url.toString();
}

export class AriEventStream {
	private readonly wsUrl: string;
	private readonly app: string;
	private readonly username: string;
	private readonly password: string;
	private readonly subscribeAll: boolean;
	private readonly initialBackoffMs: number;
	private readonly maxBackoffMs: number;

	private readonly handlers = new Map<AriEventName, Set<AriAnyEventHandler>>();
	private readonly anyHandlers = new Set<AriAnyEventHandler>();
	private readonly connectedHandlers = new Set<() => void>();
	private readonly disconnectedHandlers = new Set<(info: AriDisconnectInfo) => void>();

	private socket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private stopped = true;
	private connected = false;

	constructor(options: AriEventStreamOptions = {}) {
		const baseUrl = process.env.ASTERISK_ARI_URL ?? DEFAULT_ARI_URL;
		this.wsUrl = options.url ?? process.env.ASTERISK_ARI_WS_URL ?? deriveWsUrl(baseUrl);
		this.app = options.app ?? process.env.ASTERISK_ARI_APP ?? DEFAULT_ARI_APP;
		this.username = options.username ?? process.env.ASTERISK_ARI_USERNAME ?? "";
		this.password = options.password ?? process.env.ASTERISK_ARI_PASSWORD ?? "";
		this.subscribeAll = options.subscribeAll ?? true;
		this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
		this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

		if (options.onConnected) {
			this.connectedHandlers.add(options.onConnected);
		}
		if (options.onDisconnected) {
			this.disconnectedHandlers.add(options.onDisconnected);
		}
	}

	get isConnected(): boolean {
		return this.connected;
	}

	get applicationName(): string {
		return this.app;
	}

	// -----------------------------------------
	// Subscriptions
	// -----------------------------------------

	/** Subscribe to one event type. Returns an unsubscribe function. */
	on<TName extends AriEventName>(event: TName, handler: AriEventHandler<TName>): () => void {
		let set = this.handlers.get(event);
		if (!set) {
			set = new Set();
			this.handlers.set(event, set);
		}
		set.add(handler as AriAnyEventHandler);

		return () => {
			this.off(event, handler);
		};
	}

	off<TName extends AriEventName>(event: TName, handler: AriEventHandler<TName>): void {
		const set = this.handlers.get(event);
		if (!set) {
			return;
		}
		set.delete(handler as AriAnyEventHandler);
		if (set.size === 0) {
			this.handlers.delete(event);
		}
	}

	/** Every event, including ones with no typed handler. Returns an unsubscribe function. */
	onAny(handler: AriAnyEventHandler): () => void {
		this.anyHandlers.add(handler);
		return () => {
			this.anyHandlers.delete(handler);
		};
	}

	onConnected(handler: () => void): () => void {
		this.connectedHandlers.add(handler);
		return () => {
			this.connectedHandlers.delete(handler);
		};
	}

	onDisconnected(handler: (info: AriDisconnectInfo) => void): () => void {
		this.disconnectedHandlers.add(handler);
		return () => {
			this.disconnectedHandlers.delete(handler);
		};
	}

	// -----------------------------------------
	// Lifecycle
	// -----------------------------------------

	start(): void {
		if (!this.stopped) {
			logger.debug("ARI event stream already started");
			return;
		}

		if (!(this.username && this.password)) {
			logger.warn(
				{ url: this.redactedUrl() },
				"ARI credentials are not configured; the event stream will keep retrying"
			);
		}

		this.stopped = false;
		this.reconnectAttempts = 0;
		this.connect();
	}

	/** Closes the socket and cancels any pending reconnect. The stream stays down until start(). */
	stop(): void {
		this.stopped = true;

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		const socket = this.socket;
		this.socket = null;

		if (socket) {
			// Detach first: the close handler must not schedule a reconnect.
			socket.onopen = null;
			socket.onmessage = null;
			socket.onerror = null;
			socket.onclose = null;
			try {
				socket.close(1000, "shutdown");
			} catch (cause) {
				logger.debug({ err: cause }, "closing the ARI event socket threw, ignoring");
			}
		}

		if (this.connected) {
			this.connected = false;
			this.emitDisconnected({ code: 1000, reason: "stopped" });
		}

		logger.info("ARI event stream stopped");
	}

	// -----------------------------------------
	// Internals
	// -----------------------------------------

	private buildUrl(): string {
		// The api_key value is `user:pass` with a literal colon, which is the form
		// Asterisk's HTTP layer expects; each half is still percent-encoded.
		const query = [
			`app=${encodeURIComponent(this.app)}`,
			`subscribeAll=${this.subscribeAll ? "true" : "false"}`,
			`api_key=${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}`,
		].join("&");

		return `${this.wsUrl}${this.wsUrl.includes("?") ? "&" : "?"}${query}`;
	}

	/** Same URL with the credentials removed, for logs. */
	private redactedUrl(): string {
		return `${this.wsUrl}?app=${this.app}&subscribeAll=${this.subscribeAll}&api_key=***`;
	}

	private connect(): void {
		if (this.stopped) {
			return;
		}

		let socket: WebSocket;
		try {
			socket = new WebSocket(this.buildUrl());
		} catch (cause) {
			logger.error({ err: cause, url: this.redactedUrl() }, "failed to open the ARI event socket");
			this.scheduleReconnect();
			return;
		}

		this.socket = socket;

		socket.onopen = () => {
			if (this.socket !== socket) {
				return;
			}
			this.reconnectAttempts = 0;
			this.connected = true;
			logger.info({ app: this.app, url: this.redactedUrl() }, "ARI event stream connected");
			for (const handler of this.connectedHandlers) {
				this.safely(handler, "connected");
			}
		};

		socket.onmessage = (event: MessageEvent) => {
			if (this.socket !== socket) {
				return;
			}
			this.handleMessage(event.data);
		};

		socket.onerror = () => {
			if (this.socket !== socket) {
				return;
			}
			// The browser-style API gives no detail here; onclose carries the code.
			logger.warn({ url: this.redactedUrl() }, "ARI event socket error");
		};

		socket.onclose = (event: CloseEvent) => {
			if (this.socket !== socket) {
				return;
			}
			this.socket = null;
			const wasConnected = this.connected;
			this.connected = false;

			const info: AriDisconnectInfo = {
				code: event.code,
				reason: event.reason || "",
			};

			if (wasConnected) {
				logger.warn(info, "ARI event stream disconnected");
			}
			this.emitDisconnected(info);
			this.scheduleReconnect();
		};
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) {
			return;
		}

		this.reconnectAttempts += 1;

		// Full jitter: uniform in [0, exponential], floored so a refused
		// connection cannot spin. The floor never exceeds the ceiling.
		const exponential = Math.min(
			this.maxBackoffMs,
			this.initialBackoffMs * 2 ** (this.reconnectAttempts - 1)
		);
		const floorMs = Math.min(MIN_BACKOFF_MS, exponential);
		const delayMs = Math.max(floorMs, Math.round(Math.random() * exponential));

		logger.warn(
			{ attempt: this.reconnectAttempts, delayMs, ceilingMs: exponential },
			"reconnecting to the ARI event stream"
		);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delayMs);
	}

	private emitDisconnected(info: AriDisconnectInfo): void {
		for (const handler of this.disconnectedHandlers) {
			try {
				handler(info);
			} catch (cause) {
				logger.error({ err: cause }, "ARI disconnected handler threw");
			}
		}
	}

	private safely(handler: () => void, label: string): void {
		try {
			handler();
		} catch (cause) {
			logger.error({ err: cause }, `ARI ${label} handler threw`);
		}
	}

	private handleMessage(data: unknown): void {
		if (typeof data !== "string") {
			logger.debug("ignoring a non-text frame on the ARI event stream");
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch (cause) {
			logger.error({ err: cause, preview: data.slice(0, 200) }, "unparseable ARI event");
			return;
		}

		if (!parsed || typeof parsed !== "object") {
			return;
		}

		const candidate = parsed as { type?: unknown };
		if (typeof candidate.type !== "string") {
			logger.debug("ignoring an ARI frame with no event type");
			return;
		}

		// Asterisk emits event types this layer does not model. They are handed to
		// onAny subscribers as-is and otherwise dropped, deliberately: an unknown
		// event must never take the stream down.
		const event = parsed as AriEvent;

		for (const handler of this.anyHandlers) {
			try {
				handler(event);
			} catch (cause) {
				logger.error({ err: cause, type: event.type }, "ARI onAny handler threw");
			}
		}

		const set = this.handlers.get(event.type);
		if (!set) {
			return;
		}

		for (const handler of set) {
			try {
				handler(event);
			} catch (cause) {
				logger.error({ err: cause, type: event.type }, "ARI event handler threw");
			}
		}
	}
}
