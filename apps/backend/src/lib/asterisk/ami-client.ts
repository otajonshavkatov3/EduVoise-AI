// biome-ignore-all lint/style/useNamingConvention: AMI header keys are PascalCase on the wire (Event, ActionID, Response) and are read back verbatim.
/**
 * AMI client (Asterisk Manager Interface) over a raw TCP socket.
 *
 * ARI covers call control, so AMI is used only for what ARI does not expose
 * cleanly: PJSIP endpoint and contact state - i.e. "is extension 101 actually
 * registered right now, and is it in use". That is what lets the dashboard show
 * live operator availability and what the transfer logic consults before
 * ringing someone.
 *
 * The wire protocol is plain text: packets are CRLF-delimited `Key: value`
 * lines terminated by a blank line. Three details drive the implementation:
 *
 *   - On connect the server sends a banner line ("Asterisk Call Manager/9.0.0")
 *     that is *not* followed by a blank line, so it has to be consumed before
 *     the packet splitter starts.
 *   - Replies are matched to requests by ActionID, generated here per action,
 *     because events for other actions and unrelated events interleave freely.
 *   - List actions (PJSIPShowEndpoints and friends) answer with
 *     `EventList: start`, then one event per item, then a `...Complete` event.
 *     Those items are collected against the pending action rather than emitted
 *     as loose events.
 */
import { createConnection, type Socket } from "node:net";
import pino from "pino";
import pretty from "pino-pretty";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "asterisk:ami-client",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 5038;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Full jitter may draw ~0 ms; floored so a refused port cannot spin. */
const MIN_BACKOFF_MS = 100;
const PACKET_SEPARATOR = "\r\n\r\n";
const BANNER_PREFIX = "Asterisk Call Manager";

/** One decoded AMI packet. Repeated keys (Output:, Variable:) are joined with newlines. */
export type AmiPacket = Record<string, string>;

/** An AMI packet that carries an Event name. */
export type AmiEvent = AmiPacket & { Event: string };

export interface AmiActionResult {
	response: AmiPacket;
	/** Items collected for a list action; empty for a plain action. */
	events: AmiEvent[];
}

export interface AmiClientOptions {
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	actionTimeoutMs?: number;
	initialBackoffMs?: number;
	maxBackoffMs?: number;
	/** Send `Events: on` at login. Turn off to use AMI purely request/response. */
	receiveEvents?: boolean;
}

export interface PjsipEndpointInfo {
	/** PJSIP endpoint name, which is the extension for this deployment. */
	endpoint: string;
	/** Asterisk device state: "Not in use", "In use", "Unavailable", "Ringing", ... */
	state: string;
	/** Contact identifiers as AMI reports them, e.g. "101/sip:101@10.0.0.5:5060". */
	contacts: string[];
}

export interface PjsipContactInfo {
	/** Contact object name / id. */
	contact: string;
	endpoint: string;
	uri: string;
	/** "Reachable", "Unreachable", "Unknown", "NonQualified", "Created", "Removed". */
	status: string;
	roundtripUsec: number | null;
	userAgent: string | null;
	viaAddress: string | null;
	expirationTime: string | null;
}

type AmiEventListener = (event: AmiEvent) => void;
type AmiLifecycleListener = () => void;
type AmiListenerType = "event" | "connected" | "disconnected";

interface PendingAction {
	action: string;
	actionId: string;
	events: AmiEvent[];
	response: AmiPacket | null;
	timer: ReturnType<typeof setTimeout>;
	resolve: (result: AmiActionResult) => void;
	reject: (error: Error) => void;
}

/** An action Asterisk answered with `Response: Error`. Carries the packet, whose Message says why. */
export class AmiActionError extends Error {
	public readonly action: string;
	public readonly packet: AmiPacket;

	constructor(action: string, packet: AmiPacket) {
		super(`AMI action "${action}" failed: ${packet.Message ?? "no message"}`);
		this.name = "AmiActionError";
		this.action = action;
		this.packet = packet;

		Error.captureStackTrace(this, this.constructor);
	}
}

/** Strips CRLF so a value can never inject an extra header line. */
function sanitiseValue(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

/** "a, b ,, c" -> ["a", "b", "c"] */
function splitList(value: string | undefined): string[] {
	if (!value) {
		return [];
	}
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function toNumberOrNull(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? null : parsed;
}

function resolvePort(explicit: number | undefined): number {
	if (explicit !== undefined) {
		return explicit;
	}
	const fromEnv = toNumberOrNull(process.env.ASTERISK_AMI_PORT);
	return fromEnv && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

export class AmiClient {
	private readonly host: string;
	private readonly port: number;
	private readonly username: string;
	private readonly password: string;
	private readonly actionTimeoutMs: number;
	private readonly initialBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly receiveEvents: boolean;

	private readonly eventListeners = new Set<AmiEventListener>();
	private readonly connectedListeners = new Set<AmiLifecycleListener>();
	private readonly disconnectedListeners = new Set<AmiLifecycleListener>();
	private readonly pending = new Map<string, PendingAction>();

	private socket: Socket | null = null;
	private buffer = "";
	private bannerConsumed = false;
	private banner: string | null = null;
	private authenticated = false;
	private loginInFlight: Promise<void> | null = null;
	/** Set by close(): suppresses reconnects. */
	private closedByUs = true;
	/** Set when Asterisk rejects the credentials: retrying those forever is pure noise. */
	private authRejected = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private actionCounter = 0;

	constructor(options: AmiClientOptions = {}) {
		this.host = options.host ?? process.env.ASTERISK_AMI_HOST ?? DEFAULT_HOST;
		this.port = resolvePort(options.port);
		this.username = options.username ?? process.env.ASTERISK_AMI_USERNAME ?? "";
		this.password = options.password ?? process.env.ASTERISK_AMI_PASSWORD ?? "";
		this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
		this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
		this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
		this.receiveEvents = options.receiveEvents ?? true;
	}

	get isConnected(): boolean {
		return this.authenticated;
	}

	/** Banner reported by Asterisk, e.g. "Asterisk Call Manager/9.0.0". Null before the first connect. */
	get serverBanner(): string | null {
		return this.banner;
	}

	// -----------------------------------------
	// Listeners
	// -----------------------------------------

	on(type: "event", listener: AmiEventListener): () => void;
	on(type: "connected" | "disconnected", listener: AmiLifecycleListener): () => void;
	on(type: AmiListenerType, listener: AmiEventListener | AmiLifecycleListener): () => void {
		if (type === "event") {
			const eventListener = listener as AmiEventListener;
			this.eventListeners.add(eventListener);
			return () => {
				this.eventListeners.delete(eventListener);
			};
		}

		const lifecycleListener = listener as AmiLifecycleListener;
		const target = type === "connected" ? this.connectedListeners : this.disconnectedListeners;
		target.add(lifecycleListener);
		return () => {
			target.delete(lifecycleListener);
		};
	}

	off(type: "event", listener: AmiEventListener): void;
	off(type: "connected" | "disconnected", listener: AmiLifecycleListener): void;
	off(type: AmiListenerType, listener: AmiEventListener | AmiLifecycleListener): void {
		if (type === "event") {
			this.eventListeners.delete(listener as AmiEventListener);
			return;
		}
		const target = type === "connected" ? this.connectedListeners : this.disconnectedListeners;
		target.delete(listener as AmiLifecycleListener);
	}

	// -----------------------------------------
	// Lifecycle
	// -----------------------------------------

	/** Connects (if needed) and authenticates. Safe to call repeatedly; concurrent calls share one attempt. */
	async login(): Promise<void> {
		this.closedByUs = false;
		this.authRejected = false;

		if (this.authenticated) {
			return;
		}

		if (this.loginInFlight) {
			await this.loginInFlight;
			return;
		}

		const attempt = this.connectAndAuthenticate();
		this.loginInFlight = attempt;
		try {
			await attempt;
		} finally {
			this.loginInFlight = null;
		}
	}

	/** Closes the socket, fails anything in flight and stops reconnecting. */
	close(): void {
		this.closedByUs = true;

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		this.failPending(new Error("AMI client closed"));

		const socket = this.socket;
		this.socket = null;
		this.authenticated = false;

		if (socket) {
			socket.removeAllListeners();
			socket.destroy();
		}

		logger.info("AMI client closed");
	}

	// -----------------------------------------
	// Actions
	// -----------------------------------------

	/**
	 * Sends an action and resolves with the matching Response packet.
	 * Rejects on `Response: Error`, on timeout and on a dropped connection.
	 */
	async action(name: string, params: Record<string, string | number> = {}): Promise<AmiPacket> {
		const { response } = await this.actionWithEvents(name, params);
		return response;
	}

	/**
	 * Sends an action and resolves with the Response plus every list item that
	 * followed it. Use this for the *Show* actions; `action()` is enough otherwise.
	 */
	async actionWithEvents(
		name: string,
		params: Record<string, string | number> = {}
	): Promise<AmiActionResult> {
		await this.login();
		return await this.dispatch(name, params);
	}

	/** Live PJSIP endpoints with their device state and registered contacts. */
	async pjsipShowEndpoints(): Promise<PjsipEndpointInfo[]> {
		const { events } = await this.actionWithEvents("PJSIPShowEndpoints");

		return events
			.filter((event) => event.Event === "EndpointList")
			.map((event) => ({
				endpoint: event.ObjectName ?? "",
				state: event.DeviceState ?? "Unknown",
				contacts: splitList(event.Contacts),
			}));
	}

	/** Registered PJSIP contacts - the authoritative "is this softphone online" answer. */
	async pjsipShowContacts(): Promise<PjsipContactInfo[]> {
		const { events } = await this.actionWithEvents("PJSIPShowContacts");

		return events
			.filter((event) => event.Event === "ContactList")
			.map((event) => ({
				contact: event.ObjectName ?? event.ID ?? "",
				endpoint: event.Endpoint ?? event.Aor ?? "",
				uri: event.Uri ?? event.URI ?? "",
				status: event.Status ?? "Unknown",
				roundtripUsec: toNumberOrNull(event.RoundtripUsec),
				userAgent: event.UserAgent ?? null,
				viaAddress: event.ViaAddr ?? null,
				expirationTime: event.ExpirationTime ?? null,
			}));
	}

	// -----------------------------------------
	// Connection internals
	// -----------------------------------------

	private async connectAndAuthenticate(): Promise<void> {
		if (!(this.username && this.password)) {
			throw new Error(
				"AMI credentials are not configured (ASTERISK_AMI_USERNAME / ASTERISK_AMI_PASSWORD)"
			);
		}

		await this.openSocket();

		try {
			await this.dispatch("Login", {
				Username: this.username,
				Secret: this.password,
				Events: this.receiveEvents ? "on" : "off",
			});
		} catch (cause) {
			if (cause instanceof AmiActionError) {
				// Bad credentials or a denied ACL. Do not reconnect on a loop.
				this.authRejected = true;
			}
			const socket = this.socket;
			this.socket = null;
			if (socket) {
				socket.removeAllListeners();
				socket.destroy();
			}
			throw cause;
		}

		this.authenticated = true;
		this.reconnectAttempts = 0;
		logger.info(
			{ host: this.host, port: this.port, banner: this.banner },
			"AMI connected and authenticated"
		);

		for (const listener of this.connectedListeners) {
			this.safely(listener, "connected");
		}
	}

	private openSocket(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = createConnection({ host: this.host, port: this.port });
			socket.setEncoding("utf8");
			socket.setKeepAlive(true, 30_000);

			const onConnectError = (cause: Error) => {
				socket.removeAllListeners();
				socket.destroy();
				reject(new Error(`AMI connection to ${this.host}:${this.port} failed: ${cause.message}`));
			};

			socket.once("error", onConnectError);

			socket.once("connect", () => {
				socket.off("error", onConnectError);

				this.socket = socket;
				this.buffer = "";
				this.bannerConsumed = false;

				socket.on("data", (chunk: string) => {
					this.onData(chunk);
				});
				socket.on("error", (cause: Error) => {
					logger.warn({ err: cause }, "AMI socket error");
				});
				socket.on("close", () => {
					this.onSocketClose(socket);
				});

				resolve();
			});
		});
	}

	private onSocketClose(socket: Socket): void {
		if (this.socket && this.socket !== socket) {
			// A newer socket already took over; nothing to tear down.
			return;
		}

		const wasAuthenticated = this.authenticated;
		this.socket = null;
		this.authenticated = false;
		this.buffer = "";
		this.bannerConsumed = false;

		this.failPending(new Error("AMI connection closed"));

		if (wasAuthenticated) {
			logger.warn({ host: this.host, port: this.port }, "AMI connection closed");
			for (const listener of this.disconnectedListeners) {
				this.safely(listener, "disconnected");
			}
		}

		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.closedByUs || this.authRejected || this.reconnectTimer) {
			return;
		}

		this.reconnectAttempts += 1;

		// Full jitter, floored so a refused port cannot spin. The floor never
		// exceeds the ceiling.
		const exponential = Math.min(
			this.maxBackoffMs,
			this.initialBackoffMs * 2 ** (this.reconnectAttempts - 1)
		);
		const floorMs = Math.min(MIN_BACKOFF_MS, exponential);
		const delayMs = Math.max(floorMs, Math.round(Math.random() * exponential));

		logger.warn(
			{ attempt: this.reconnectAttempts, delayMs, ceilingMs: exponential },
			"reconnecting to AMI"
		);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.login().catch((cause: unknown) => {
				logger.error({ err: cause }, "AMI reconnect attempt failed");
			});
		}, delayMs);
	}

	// -----------------------------------------
	// Protocol internals
	// -----------------------------------------

	private onData(chunk: string): void {
		this.buffer += chunk;

		if (!this.bannerConsumed) {
			const lineEnd = this.buffer.indexOf("\r\n");
			if (lineEnd === -1) {
				// The greeting has no blank line after it, so wait for the full line
				// before deciding whether it is a banner.
				return;
			}

			const firstLine = this.buffer.slice(0, lineEnd);
			if (firstLine.startsWith(BANNER_PREFIX)) {
				this.banner = firstLine.trim();
				this.buffer = this.buffer.slice(lineEnd + 2);
			}
			this.bannerConsumed = true;
		}

		let boundary = this.buffer.indexOf(PACKET_SEPARATOR);
		while (boundary !== -1) {
			const raw = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + PACKET_SEPARATOR.length);

			if (raw.trim().length > 0) {
				this.handlePacket(AmiClient.parsePacket(raw));
			}

			boundary = this.buffer.indexOf(PACKET_SEPARATOR);
		}
	}

	private static parsePacket(raw: string): AmiPacket {
		const packet: AmiPacket = {};

		for (const line of raw.split("\r\n")) {
			if (!line) {
				continue;
			}

			const separator = line.indexOf(":");
			if (separator === -1) {
				continue;
			}

			const key = line.slice(0, separator).trim();
			const value = line.slice(separator + 1).trim();
			if (!key) {
				continue;
			}

			// Output:/Variable: legitimately repeat within one packet.
			const existing = packet[key];
			packet[key] = existing === undefined ? value : `${existing}\n${value}`;
		}

		return packet;
	}

	private handlePacket(packet: AmiPacket): void {
		const actionId = packet.ActionID;
		const pendingAction = actionId ? this.pending.get(actionId) : undefined;

		if (pendingAction) {
			this.applyToPending(pendingAction, packet);
			return;
		}

		if (packet.Event) {
			this.emitEvent(packet as AmiEvent);
		}
	}

	private applyToPending(pendingAction: PendingAction, packet: AmiPacket): void {
		if (packet.Response !== undefined) {
			pendingAction.response = packet;

			if (/error/i.test(packet.Response)) {
				this.settle(pendingAction, new AmiActionError(pendingAction.action, packet));
				return;
			}

			// A list action says so either with `EventList: start` or with a Message
			// ending in "follow(s)"; anything else is complete right here.
			const startsList =
				/^start$/i.test(packet.EventList ?? "") || /follow/i.test(packet.Message ?? "");
			if (!startsList) {
				this.settle(pendingAction);
			}
			return;
		}

		if (packet.Event) {
			const event = packet as AmiEvent;
			const isTerminator =
				/^complete$/i.test(packet.EventList ?? "") || event.Event.endsWith("Complete");

			if (isTerminator) {
				this.settle(pendingAction);
				return;
			}

			pendingAction.events.push(event);
		}
	}

	private dispatch(
		name: string,
		params: Record<string, string | number>
	): Promise<AmiActionResult> {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			return Promise.reject(new Error(`AMI action "${name}" failed: not connected`));
		}

		this.actionCounter += 1;
		const actionId = `${Date.now().toString(36)}-${this.actionCounter}`;

		const lines = [`Action: ${name}`, `ActionID: ${actionId}`];
		for (const [key, value] of Object.entries(params)) {
			lines.push(`${key}: ${sanitiseValue(String(value))}`);
		}
		const payload = `${lines.join("\r\n")}${PACKET_SEPARATOR}`;

		return new Promise<AmiActionResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(actionId);
				reject(new Error(`AMI action "${name}" timed out after ${this.actionTimeoutMs}ms`));
			}, this.actionTimeoutMs);

			const pendingAction: PendingAction = {
				action: name,
				actionId,
				events: [],
				response: null,
				timer,
				resolve,
				reject,
			};

			this.pending.set(actionId, pendingAction);

			socket.write(payload, "utf8", (cause?: Error | null) => {
				if (cause) {
					this.settle(
						pendingAction,
						new Error(`AMI action "${name}" write failed: ${cause.message}`)
					);
				}
			});
		});
	}

	private settle(pendingAction: PendingAction, error?: Error): void {
		if (!this.pending.delete(pendingAction.actionId)) {
			// Already settled by a timeout or a disconnect.
			return;
		}
		clearTimeout(pendingAction.timer);

		if (error) {
			pendingAction.reject(error);
			return;
		}

		pendingAction.resolve({
			response: pendingAction.response ?? {},
			events: pendingAction.events,
		});
	}

	private failPending(error: Error): void {
		for (const pendingAction of [...this.pending.values()]) {
			this.settle(pendingAction, error);
		}
	}

	private emitEvent(event: AmiEvent): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch (cause) {
				logger.error({ err: cause, event: event.Event }, "AMI event listener threw");
			}
		}
	}

	private safely(listener: AmiLifecycleListener, label: string): void {
		try {
			listener();
		} catch (cause) {
			logger.error({ err: cause }, `AMI ${label} listener threw`);
		}
	}
}

let sharedClient: AmiClient | null = null;

/**
 * Process-wide AMI client. One authenticated connection is enough for the
 * whole backend, and manager.conf allows a limited number of sessions.
 */
export function getAmiClient(): AmiClient {
	if (!sharedClient) {
		sharedClient = new AmiClient();
	}
	return sharedClient;
}
