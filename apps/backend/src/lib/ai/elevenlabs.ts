/**
 * ElevenLabs speech, rendered straight into telephony audio.
 *
 * The API can emit `ulaw_8000` directly, which is exactly what Asterisk carries,
 * so nothing is resampled between here and the caller's ear - the same reason the
 * OpenAI leg uses PCMU.
 *
 * WHY THIS EXISTS ALONGSIDE THE REALTIME VOICE
 *
 * The Realtime model is speech-to-speech: it reasons and speaks in one stream,
 * which is why it is fast. ElevenLabs is text-to-speech only, so using it means
 * splitting that in two and paying a second network hop. Measured against this
 * account, time to the FIRST audio byte on an 88-character line:
 *
 *   eleven_v3              streaming   1662 ms
 *   eleven_v3              one shot    3172 ms
 *   eleven_flash_v2_5      streaming    202 ms
 *   eleven_turbo_v2_5      streaming    272 ms
 *   eleven_multilingual_v2 streaming    893 ms
 *
 * v3 is the one that reads Uzbek well and the one the business chose, and 1.7 s
 * of dead air before every reply is not something a caller tolerates. So v3 is
 * used where the text is known IN ADVANCE - the greeting, the closing line, the
 * transfer announcement, the holding lines - and those are rendered once and
 * served from disk at zero latency. `renderStream` exists for the dynamic path.
 *
 * NOTE ON UZBEK: no model here lists `uz` among its supported languages (v3
 * claims 74, flash/turbo 32). It reads Latin-script Uzbek convincingly anyway,
 * which is why it was chosen - but it is unsupported, so quality can move under
 * us and the cache below is also what keeps that blast radius small.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";
import pretty from "pino-pretty";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{ level: process.env.LOG_LEVEL ?? "info", base: { module: "ai:elevenlabs" } },
	isProduction ? undefined : pretty({ colorize: true, translateTime: "HH:MM:ss.l" })
);

const API_BASE = "https://api.elevenlabs.io/v1";

/**
 * The model the business picked for Uzbek.
 *
 * Overridable because the trade-off is real: ELEVENLABS_MODEL=eleven_flash_v2_5
 * turns 1.7 s of latency into 0.2 s at the cost of the voice quality that made
 * ElevenLabs worth adding.
 */
const DEFAULT_MODEL = "eleven_v3";

/** Sarah - mature, reassuring; the closest premade voice to a receptionist. */
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

/**
 * u-law at 8 kHz: Asterisk's own codec, so the bytes pass through untouched.
 * Every other format would cost a resample on a live call.
 */
const OUTPUT_FORMAT = "ulaw_8000";

/** A render that has not produced a byte by now is not going to save the turn. */
const RENDER_TIMEOUT_MS = 15_000;

/** Where pre-rendered lines live between restarts. */
const CACHE_DIR = join(process.cwd(), ".cache", "elevenlabs");

export interface ElevenLabsOptions {
	apiKey?: string;
	voiceId?: string;
	model?: string;
}

export interface RenderedSpeech {
	/** 8 kHz u-law, ready for Asterisk. */
	ulaw: Buffer;
	/** How long it will take to play, in milliseconds. */
	durationMs: number;
	/** True when this came from disk rather than the API. */
	cached: boolean;
}

/**
 * Off unless explicitly switched on, and a key alone is not enough.
 *
 * A key being present used to be the whole condition, and the result was a call
 * that opened in the ElevenLabs voice and then continued in the realtime model's
 * - a different person answering the second sentence. On a phone line that reads
 * as a transfer, or as a recording followed by a bot, and it is worse than either
 * voice on its own.
 *
 * So this stays off until one voice can carry the WHOLE call. Set
 * ELEVENLABS_FIXED_LINES=true only when the conversational voice is the same
 * voice as the one rendering here.
 */
export function isElevenLabsConfigured(): boolean {
	if ((process.env.ELEVENLABS_FIXED_LINES ?? "").trim().toLowerCase() !== "true") {
		return false;
	}

	return readApiKey().length > 0;
}

function readApiKey(): string {
	return (process.env.ELEVENLABS_API_KEY ?? "").trim();
}

function resolve(options: ElevenLabsOptions): { apiKey: string; voiceId: string; model: string } {
	return {
		apiKey: options.apiKey ?? readApiKey(),
		voiceId: options.voiceId ?? (process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID).trim(),
		model: options.model ?? (process.env.ELEVENLABS_MODEL ?? DEFAULT_MODEL).trim(),
	};
}

/** u-law is one byte per sample, so 8000 bytes is exactly one second. */
function durationOf(ulaw: Buffer): number {
	return Math.round((ulaw.length / 8000) * 1000);
}

/**
 * Cache key: the text plus everything that changes how it sounds.
 *
 * The model and the voice are in the key on purpose - switching either one must
 * not serve yesterday's audio in yesterday's voice.
 */
function cacheKey(text: string, voiceId: string, model: string): string {
	return createHash("sha256").update(`${model}|${voiceId}|${text}`).digest("hex").slice(0, 32);
}

/**
 * Speak a line that is known in advance, from disk when possible.
 *
 * This is the path that makes v3 usable on a phone call at all: the greeting, the
 * goodbye and the transfer announcement are fixed strings, so they are rendered
 * once and then cost nothing - no API call, no billing, and no 1.7 s wait.
 */
export async function renderCached(
	text: string,
	options: ElevenLabsOptions = {}
): Promise<RenderedSpeech | null> {
	const { apiKey, voiceId, model } = resolve(options);
	const trimmed = text.trim();

	if (apiKey.length === 0 || trimmed.length === 0) {
		return null;
	}

	const key = cacheKey(trimmed, voiceId, model);
	const file = join(CACHE_DIR, `${key}.ulaw`);

	try {
		const ulaw = await readFile(file);

		return { ulaw, durationMs: durationOf(ulaw), cached: true };
	} catch {
		// Not rendered yet. Fall through and produce it.
	}

	const ulaw = await render(trimmed, { apiKey, voiceId, model });

	if (ulaw === null) {
		return null;
	}

	try {
		await mkdir(CACHE_DIR, { recursive: true });
		await writeFile(file, ulaw);
	} catch (cause) {
		// A cache that cannot be written is a performance problem, not a call
		// problem: the audio is already in hand and the caller will hear it.
		logger.warn({ err: cause, file }, "could not cache the rendered line");
	}

	logger.info(
		{ chars: trimmed.length, ms: durationOf(ulaw), model, voiceId },
		"rendered and cached a fixed line"
	);

	return { ulaw, durationMs: durationOf(ulaw), cached: false };
}

/** One-shot render. Returns null on any failure - the caller falls back. */
async function render(
	text: string,
	config: { apiKey: string; voiceId: string; model: string }
): Promise<Buffer | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);

	try {
		const res = await fetch(
			`${API_BASE}/text-to-speech/${config.voiceId}/stream?output_format=${OUTPUT_FORMAT}`,
			{
				method: "POST",
				headers: { "xi-api-key": config.apiKey, "Content-Type": "application/json" },
				body: JSON.stringify({ text, model_id: config.model }),
				signal: controller.signal,
			}
		);

		if (!res.ok) {
			logger.error(
				{ status: res.status, detail: (await res.text()).slice(0, 200), model: config.model },
				"ElevenLabs refused the render"
			);
			return null;
		}

		return Buffer.from(await res.arrayBuffer());
	} catch (cause) {
		logger.error({ err: cause, model: config.model }, "ElevenLabs render failed");
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Stream a line that is only known now, chunk by chunk.
 *
 * `onChunk` is called with u-law bytes as they arrive, so playback can start
 * before the sentence has finished rendering. Abort the signal to stop mid-render
 * - that is what a barge-in does, and without it the caller keeps hearing a reply
 * they already interrupted.
 *
 * Returns the total bytes emitted, or null if the render never started.
 */
export async function renderStream(
	text: string,
	onChunk: (ulaw: Buffer) => void,
	options: ElevenLabsOptions & { signal?: AbortSignal } = {}
): Promise<number | null> {
	const { apiKey, voiceId, model } = resolve(options);
	const trimmed = text.trim();

	if (apiKey.length === 0 || trimmed.length === 0) {
		return null;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
	const onExternalAbort = () => controller.abort();

	options.signal?.addEventListener("abort", onExternalAbort, { once: true });

	const startedAt = Date.now();
	let firstChunkAt = -1;
	let total = 0;

	try {
		const res = await fetch(
			`${API_BASE}/text-to-speech/${voiceId}/stream?output_format=${OUTPUT_FORMAT}`,
			{
				method: "POST",
				headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
				body: JSON.stringify({ text: trimmed, model_id: model }),
				signal: controller.signal,
			}
		);

		if (!res.ok || res.body === null) {
			logger.error(
				{ status: res.status, model },
				"ElevenLabs refused the stream; the turn falls back to the realtime voice"
			);
			return null;
		}

		const reader = res.body.getReader();

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			if (firstChunkAt < 0) {
				firstChunkAt = Date.now() - startedAt;
			}

			total += value.length;
			onChunk(Buffer.from(value));
		}

		logger.debug(
			{ chars: trimmed.length, firstChunkMs: firstChunkAt, totalMs: Date.now() - startedAt, model },
			"ElevenLabs stream finished"
		);

		return total;
	} catch (cause) {
		// An abort is the expected way a barge-in ends this, not a failure.
		if (controller.signal.aborted && options.signal?.aborted === true) {
			logger.debug({ emittedBytes: total }, "ElevenLabs stream aborted by barge-in");
			return total;
		}

		logger.error({ err: cause, model }, "ElevenLabs stream failed");
		return null;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onExternalAbort);
	}
}
