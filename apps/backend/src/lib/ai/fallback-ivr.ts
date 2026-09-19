/**
 * Fallback IVR provider - the honest path when no realtime model is reachable.
 *
 * This project's OpenAI key currently has no Realtime entitlement, no
 * standalone STT and no standalone TTS. Without this provider an inbound call
 * would reach Stasis, fail to open a session, and end in dead air. With it, the
 * platform still handles the call end to end: the caller hears Asterisk's own
 * built-in prompts (played by the orchestrator over ARI) and is then put
 * through to a human being.
 *
 * Two rules define it:
 *
 *   1. It never calls a paid API. No key, no quota, no network at all.
 *   2. It never leaves the caller stranded. A short moment after the session
 *      opens it raises a `transfer_to_human` tool call, which is the same code
 *      path the AI would use, so the orchestrator needs no special case: it
 *      rings an operator, writes a `call_transfers` row, and bridges the call.
 *
 * It also writes transcript rows - one system row explaining why the AI is not
 * handling this call, and one agent row per say() - so the dashboard shows what
 * the caller was actually told instead of an empty conversation.
 */
import type { Buffer } from "node:buffer";
import pino from "pino";
import pretty from "pino-pretty";
import type {
	TranscriptRole,
	VoiceProvider,
	VoiceProviderHandlers,
	VoiceProviderStats,
	VoiceSessionContext,
} from "@/lib/telephony/contracts";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "ai:fallback-ivr",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

export const FALLBACK_IVR_PROVIDER_NAME = "fallback-ivr";

/** The reason the orchestrator sees on the transfer, and stores on the row. */
export const FALLBACK_TRANSFER_REASON = "ai_provider_unavailable";

/**
 * How long to wait before asking for a human.
 *
 * Long enough for the orchestrator to have answered the channel and started its
 * "please hold" prompt, short enough that nobody is listening to silence.
 */
const DEFAULT_TRANSFER_DELAY_MS = 1_500;

/** slin 8 kHz is 16 bytes per millisecond (8000 Hz * 2 bytes). */
const SLIN8K_BYTES_PER_MS = 16;

const DEFAULT_SYSTEM_NOTICE =
	"AI ovozli yordamchi mavjud emas (provayder ulanmadi). Qo'ng'iroq zaxira IVR " +
	"orqali operatorga uzatiladi.";

export interface FallbackIvrProviderOptions {
	/** Delay before the transfer tool call. Default 1500 ms. */
	transferDelayMs?: number;
	/** Reason reported on the transfer. Default "ai_provider_unavailable". */
	transferReason?: string;
	/** Extension to prefer, when the caller should reach a specific operator. */
	preferredExtension?: string;
	/** First system transcript line. Defaults to an Uzbek explanation. */
	systemNotice?: string;
}

class FallbackIvrProvider implements VoiceProvider {
	readonly name = FALLBACK_IVR_PROVIDER_NAME;

	private readonly transferDelayMs: number;
	private readonly transferReason: string;
	private readonly preferredExtension: string | null;
	private readonly systemNotice: string;

	private context: VoiceSessionContext | null = null;
	private handlers: VoiceProviderHandlers | null = null;

	private startedAtMs = 0;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;
	private transferTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private closeEmitted = false;
	private transferRequested = false;

	private inputBytes = 0;

	constructor(options: FallbackIvrProviderOptions = {}) {
		this.transferDelayMs = Math.max(0, options.transferDelayMs ?? DEFAULT_TRANSFER_DELAY_MS);
		this.transferReason = options.transferReason ?? FALLBACK_TRANSFER_REASON;
		this.preferredExtension = options.preferredExtension ?? null;
		this.systemNotice = options.systemNotice ?? DEFAULT_SYSTEM_NOTICE;
	}

	start(context: VoiceSessionContext, handlers: VoiceProviderHandlers): Promise<void> {
		if (this.handlers !== null) {
			throw new Error("fallback IVR provider instances handle exactly one call");
		}

		this.context = context;
		this.handlers = handlers;
		this.startedAtMs = Date.now();

		logger.info(
			{ callId: context.callId, channelId: context.channelId },
			"handling the call with the fallback IVR: no realtime provider is available"
		);

		// Deferred by one tick so the orchestrator's `await start()` has returned
		// before onReady lands - the same ordering the OpenAI provider gives.
		this.readyTimer = setTimeout(() => {
			this.readyTimer = null;
			this.announce();
		}, 0);

		this.transferTimer = setTimeout(() => {
			this.transferTimer = null;
			this.requestTransfer();
		}, this.transferDelayMs);

		return Promise.resolve();
	}

	/**
	 * Caller audio is counted and dropped. There is nothing to send it to, but
	 * the counter still makes `ai_sessions.input_audio_ms` truthful, which is how
	 * the dashboard can tell a fallback call that had a real conversation from
	 * one that was silent.
	 */
	pushAudio(slin8k: Buffer): void {
		if (this.stopped) {
			return;
		}

		this.inputBytes += slin8k.length;
	}

	/**
	 * No audio is produced: the orchestrator plays Asterisk's own prompts over
	 * ARI. The line is still recorded as an agent transcript so the live view and
	 * the call history show what the caller was told.
	 */
	say(text: string): void {
		const trimmed = text.trim();

		if (trimmed.length === 0) {
			return;
		}

		this.emitTranscript("agent", trimmed);
	}

	cancelResponse(): void {
		// Nothing is ever in flight: no model is generating audio for this call.
		logger.debug({ callId: this.context?.callId ?? null }, "fallback IVR has nothing to cancel");
	}

	sendToolResult(toolCallId: string, result: unknown): void {
		logger.debug({ toolCallId, result }, "fallback IVR ignoring a tool result");
	}

	stop(reason: string): Promise<void> {
		if (this.stopped) {
			return Promise.resolve();
		}

		this.stopped = true;

		if (this.readyTimer !== null) {
			clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}

		if (this.transferTimer !== null) {
			clearTimeout(this.transferTimer);
			this.transferTimer = null;
		}

		logger.info(
			{ callId: this.context?.callId ?? null, reason, ...this.stats() },
			"fallback IVR session stopped"
		);

		this.finish(reason);
		return Promise.resolve();
	}

	stats(): VoiceProviderStats {
		return {
			inputAudioMs: Math.round(this.inputBytes / SLIN8K_BYTES_PER_MS),
			outputAudioMs: 0,
			interruptions: 0,
		};
	}

	// -----------------------------------------
	// Internals
	// -----------------------------------------

	private announce(): void {
		if (this.stopped) {
			return;
		}

		const handlers = this.handlers;

		if (handlers === null) {
			return;
		}

		try {
			handlers.onReady();
		} catch (cause) {
			logger.error({ err: cause }, "onReady handler threw");
		}

		this.emitTranscript("system", this.systemNotice);
	}

	private requestTransfer(): void {
		if (this.stopped || this.transferRequested) {
			return;
		}

		const handlers = this.handlers;

		if (handlers === null) {
			return;
		}

		this.transferRequested = true;

		const args: Record<string, unknown> = { reason: this.transferReason };

		if (this.preferredExtension !== null) {
			args.preferredExtension = this.preferredExtension;
		}

		logger.info(
			{ callId: this.context?.callId ?? null, reason: this.transferReason },
			"fallback IVR asking for a human operator"
		);

		handlers
			.onToolCall({
				name: "transfer_to_human",
				toolCallId: crypto.randomUUID(),
				args,
			})
			.then((result) => {
				logger.debug({ result }, "fallback IVR transfer accepted");
			})
			.catch((cause: unknown) => {
				const error = cause instanceof Error ? cause : new Error(String(cause));

				logger.error({ err: error }, "fallback IVR transfer failed");
				this.emitError(error);
			});
	}

	private elapsedMs(): number {
		return this.startedAtMs === 0 ? 0 : Date.now() - this.startedAtMs;
	}

	private emitTranscript(role: TranscriptRole, content: string): void {
		const handlers = this.handlers;

		if (handlers === null) {
			return;
		}

		const at = this.elapsedMs();

		try {
			handlers.onTranscript({ role, content, isFinal: true, startMs: at, endMs: at });
		} catch (cause) {
			logger.error({ err: cause, role }, "onTranscript handler threw");
		}
	}

	private emitError(error: Error): void {
		const handlers = this.handlers;

		if (handlers === null) {
			return;
		}

		try {
			handlers.onError(error);
		} catch (cause) {
			logger.error({ err: cause }, "onError handler threw");
		}
	}

	private finish(reason: string): void {
		if (this.closeEmitted) {
			return;
		}

		this.closeEmitted = true;

		const handlers = this.handlers;

		if (handlers === null) {
			return;
		}

		try {
			handlers.onClose(reason);
		} catch (cause) {
			logger.error({ err: cause }, "onClose handler threw");
		}
	}
}

/**
 * Build the fallback provider. Instances are single-use, like every other
 * provider: one call, one instance.
 */
export function createFallbackIvrProvider(options: FallbackIvrProviderOptions = {}): VoiceProvider {
	return new FallbackIvrProvider(options);
}
