// biome-ignore-all lint/style/useNamingConvention: every snake_case identifier here is an OpenAI Realtime wire field or event name, so it must be spelled exactly as the API spells it.
/**
 * OpenAI Realtime (GA) speech-to-speech provider.
 *
 * Wire facts this implementation is built on, all verified against the live
 * endpoint - deviating from any of them breaks the connection outright:
 *
 *   URL      wss://api.openai.com/v1/realtime?model=<model>
 *   Headers  Authorization: Bearer <key>   AND NOTHING ELSE.
 *            Sending "OpenAI-Beta: realtime=v1" is fatal: the server answers
 *            with error code `beta_api_shape_disabled` and closes. The beta
 *            wire shape is dead; this module speaks the GA shape only.
 *   Audio    audio/pcmu in BOTH directions. That is G.711 u-law at 8 kHz,
 *            which is exactly Asterisk's telephony rate, so the whole bridge
 *            runs without a single resampling step: AudioSocket gives us
 *            slin8k, muLawEncode turns it into what OpenAI wants, and
 *            muLawDecode turns the reply back into what AudioSocket wants.
 *
 * The provider never touches the database or Asterisk. It converts audio,
 * tracks counters, and calls the handlers the orchestrator gave it.
 *
 * Availability is a first-class outcome, not an exception. This project's API
 * key currently has no Realtime entitlement (`model_not_found` on every
 * realtime model), so a session that cannot be established must surface
 * `VoiceProviderUnavailableError` from start() - fast, and without retrying -
 * so the orchestrator can fall back to the IVR provider while the caller is
 * still on the line. Retrying only happens for a session that was already
 * working and then dropped mid-call.
 */
import { Buffer } from "node:buffer";
import pino from "pino";
import pretty from "pino-pretty";
import type { ActiveAgentProfile, KnowledgeHit } from "@/lib/ai-agent";
import {
	type TranscriptRole,
	type VoiceProvider,
	type VoiceProviderHandlers,
	type VoiceProviderStats,
	VoiceProviderUnavailableError,
	type VoiceSessionContext,
} from "@/lib/telephony/contracts";
import { muLawDecode, muLawEncode } from "./codec";
import {
	buildGreeting,
	buildSystemInstructions,
	buildToolAcknowledgement,
	buildTranscriptionPrompt,
	formatSayDirective,
	TOOL_FAILURE_GUIDANCE,
	TOOL_RESULT_GUIDANCE,
	unconfiguredAgentProfile,
} from "./prompts";
import { buildToolDefinitions, type RealtimeToolDefinition, toolsForCall } from "./tools";
import { TurnTranscriptStream } from "./turn-transcript";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "ai:openai-realtime",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

// ===========================================
// Constants
// ===========================================

export const OPENAI_REALTIME_PROVIDER_NAME = "openai-realtime";

const DEFAULT_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const DEFAULT_MODEL = "gpt-realtime";
/**
 * `cedar`, not `alloy`.
 *
 * alloy is the flattest voice in the set - even, unaccented, and on a narrowband
 * phone line it reads as a recording rather than a person. cedar and marin are
 * the two newest Realtime voices and carry the prosody that makes a caller answer
 * naturally instead of over-enunciating at a machine. Both were verified against
 * the live GA endpoint, along with ash, ballad, coral, echo, sage, shimmer and
 * verse - any of them can be set per business through the profile's `voice`
 * field, which is what the dashboard edits.
 */
const DEFAULT_VOICE = "cedar";
/**
 * gpt-4o-transcribe, not whisper-1.
 *
 * Neither accepts `language: "uz"`, so both have to be steered by the decoding
 * prompt instead - and the newer model follows that prompt far more closely,
 * which is what stops Uzbek telephony audio being decoded as another language
 * altogether. Overridable with OPENAI_TRANSCRIBE_MODEL.
 */
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/**
 * TURN DETECTION, TUNED FOR AN 8 kHz PHONE LINE AND UZBEK SPEECH
 *
 * These three numbers decide whether the agent feels like a receptionist or like
 * something that talks over you, and the API's defaults are tuned for a laptop
 * microphone in a quiet room, not for G.711 over SIP.
 *
 * threshold 0.55 (API default 0.5)
 *   A telephony leg never goes truly silent: there is comfort noise, line hiss,
 *   a television in the room and the caller's own breathing, all inside the
 *   300-3400 Hz band and all amplified by u-law companding. At 0.5 that floor
 *   crosses the threshold often enough to fire speech_started while the agent is
 *   mid-sentence, which cancels its response and makes it sound like it keeps
 *   losing its train of thought. 0.55 clears the noise floor while still
 *   triggering on a quiet or distant caller; going past ~0.65 starts dropping
 *   soft-spoken elderly callers, which is exactly who calls a utilities hotline.
 *
 * silence_duration_ms 700 (API default 500)
 *   This is how long the caller may pause before their turn is considered over.
 *   The failure it prevents is specific and constant on this hotline: an address
 *   is dictated in pieces, with a real pause between them - "Yunusobod tumani...
 *   Amir Temur ko'chasi... o'n ikkinchi uy". At 500 ms the agent answers after
 *   the district and the rest of the address is spoken over its reply. 700 ms
 *   holds those pauses together. Much beyond 800 ms and every exchange gains a
 *   dead beat that callers read as the line having gone down.
 *
 * prefix_padding_ms 300 (API default 300, sent explicitly)
 *   Audio kept from before the trigger, so the utterance does not start clipped.
 *   Uzbek words very often open on an unvoiced consonant ("kecha", "suv",
 *   "tushunmadim") that is quiet enough not to trip the VAD by itself, so
 *   without the padding the transcript loses the first syllable - and a
 *   transcript that starts mid-word is what makes an otherwise good model answer
 *   the wrong question.
 *
 * All three are overridable per deployment through the environment, because the
 * right values depend on the carrier: OPENAI_REALTIME_VAD_THRESHOLD,
 * OPENAI_REALTIME_VAD_SILENCE_MS, OPENAI_REALTIME_VAD_PREFIX_MS.
 */
const DEFAULT_VAD_THRESHOLD = 0.55;
const DEFAULT_VAD_SILENCE_MS = 700;
const DEFAULT_VAD_PREFIX_PADDING_MS = 300;

/**
 * Semantic turn detection, and why it is the default now.
 *
 * The numbers above are the best a silence timer can do, and a silence timer is
 * the wrong instrument: it cannot tell "manzil..." (still thinking) from "manzil
 * Chilonzor." (finished). `semantic_vad` asks a model whether the utterance
 * sounds complete, so a caller who pauses mid-thought keeps the floor.
 *
 * It pays for itself twice. A measured 147-second call ran 16 turns, 3 of them
 * interrupted - each interruption is a response generated, billed and never
 * heard, followed by another full prefix re-read for the retry. Fewer wrong-moment
 * replies is simultaneously the humanness fix and the cost fix.
 *
 * Eagerness is "auto", not "low". "low" is the most patient setting and it was the
 * first choice here, on the reasoning that waiting is safer than interrupting -
 * but on a real call it reads as a hesitant agent that takes a beat too long
 * before every reply, and a caller experiences that as the thing being slow and
 * dim rather than careful. "auto" lets the model judge each utterance: it still
 * waits through a pause that sounds unfinished, and answers straight away when
 * the sentence is plainly done. That is what a person does.
 *
 * OPENAI_REALTIME_TURN_MODE=server_vad restores the timer; OPENAI_REALTIME_VAD_EAGERNESS
 * takes low | medium | high | auto.
 */
const DEFAULT_TURN_DETECTION_MODE = "semantic_vad";
const DEFAULT_VAD_EAGERNESS = "auto";

const TURN_DETECTION_MODES: ReadonlySet<string> = new Set(["semantic_vad", "server_vad"]);
const VAD_EAGERNESS_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "auto"]);

/**
 * Playback speed for the agent's own voice.
 *
 * Slightly under one: the model's natural pace is tuned for wideband audio, and
 * on a 300-3400 Hz phone channel the consonants that carry Uzbek word endings are
 * the first thing lost. Slowing it a little buys intelligibility that no amount of
 * prompting can.
 */
const DEFAULT_OUTPUT_SPEED = 0.95;

/**
 * Hard ceiling on one spoken reply.
 *
 * Generated speech is the most expensive thing on the bill, and the failure mode
 * it guards against is a model that starts listing every service it knows. The
 * prompt already asks for two sentences; this is what happens when the prompt is
 * not obeyed.
 *
 * Measured against the live API with this deployment's audio/pcmu output, speech
 * runs 19-20 audio tokens per second, so 1200 is about a minute of talking - far
 * past any legitimate answer on a phone line, which is the point: it is a
 * backstop, not a budget. A reply that does hit it comes back with status
 * "incomplete", which handleResponseDone logs by name so the cap can be raised
 * rather than quietly clipping callers.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 1_200;

/**
 * How long a barge-in may leave the line silent before the platform asks for a
 * reply itself.
 *
 * Long enough that a caller who is genuinely mid-sentence is never talked over -
 * they are still speaking, and the recovery checks that before firing - and short
 * enough that a cough cannot turn into dead air the caller hangs up on.
 */
const BARGE_IN_RECOVERY_MS = 2_000;

/**
 * Input noise reduction. "near_field" is the setting for audio from a device
 * held against the head, which is what a phone call is; "far_field" is for a
 * room microphone and would apply the wrong assumptions to a handset. Set
 * OPENAI_REALTIME_NOISE_REDUCTION=off to send no noise-reduction block at all.
 */
const DEFAULT_NOISE_REDUCTION = "near_field";

const NOISE_REDUCTION_TYPES: ReadonlySet<string> = new Set(["near_field", "far_field"]);

/**
 * How long a tool may run before the platform speaks a holding line itself.
 *
 * The instructions tell the model to say "bir daqiqa, yozib olaman" before
 * calling a tool, and it mostly does - but when it does not, the caller gets a
 * silent turn followed by a database round trip, which on a phone line is
 * indistinguishable from the call having dropped. 400 ms is long enough that a
 * fast tool never triggers a redundant line, and short enough that the gap never
 * grows into a silence the caller reacts to.
 */
const DEFAULT_TOOL_ACKNOWLEDGEMENT_DELAY_MS = 400;

/** Longest a tool result's error text may be when handed back to the model. */
const MAX_TOOL_ERROR_CHARS = 400;

/**
 * A pending response.create is flushed no later than this even if the
 * `response.done` that should have released it never arrives. Prevents a lost
 * event from leaving the caller in permanent silence.
 */
const PENDING_RESPONSE_TIMEOUT_MS = 5_000;

/** Lines held for a session that is not ready yet (greeting on a reconnect). */
const MAX_PENDING_SAY_LINES = 3;

/** Optional `session.update` fields, dropped one by one if the API rejects one. */
type SessionExtra =
	| "noise_reduction"
	| "prefix_padding"
	| "transcription_language"
	| "turn_detection_mode"
	| "output_speed"
	| "max_output_tokens";

/**
 * Wire paths of the optional fields, used to match an API error back to the
 * field that caused it.
 *
 * Every entry here is a field this project has NOT verified against the live GA
 * endpoint, unlike the audio formats and the tool shape. Guessing wrong about
 * one of them must not cost the whole session.update - which carries the
 * instructions and the tools - so an error naming one of these disables just
 * that field and the update is sent again.
 */
const SESSION_EXTRA_MARKERS: Record<SessionExtra, readonly string[]> = {
	noise_reduction: ["noise_reduction"],
	prefix_padding: ["prefix_padding_ms", "prefix_padding"],
	transcription_language: ["transcription.language", "language"],
	// Dropping this falls back to server_vad, which every deployment supports.
	//
	// The param path is listed FIRST and explicitly: an API that simply does not
	// know the field answers with `param: "session.audio.input.turn_detection.type"`
	// and never echoes the value, so matching only on "semantic_vad"/"eagerness"
	// would match nothing - and a marker that matches nothing does not degrade the
	// field, it leaves the WHOLE session.update rejected. That is not a degraded
	// call, it is a call with no instructions, no tools and the wrong codec.
	turn_detection_mode: ["turn_detection.type", "turn_detection", "semantic_vad", "eagerness"],
	output_speed: ["output.speed", "audio.output.speed"],
	max_output_tokens: ["max_output_tokens"],
};

/**
 * How many times session.update may be retried with fewer optional fields.
 *
 * One per optional field, not a fixed three. There are six of them now, and a
 * deployment that rejects four would previously have run out of retries and come
 * up with NO instructions and NO tools - the retry budget silently becoming the
 * thing that broke the call. Each retry drops exactly one field, so the worst case
 * is bounded by the number of fields, and every one of them is optional by
 * construction.
 */
const MAX_SESSION_DEGRADATIONS = 6;

/**
 * How long to wait for `session.updated` after `session.created` before
 * declaring the session ready anyway. The update is echoed in practice, but a
 * caller is on the line: a missing echo must not hold the greeting back.
 */
const DEFAULT_READY_GRACE_MS = 1_500;

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 400;
const DEFAULT_MAX_BACKOFF_MS = 4_000;

/** G.711 u-law at 8 kHz is exactly 8 bytes per millisecond of audio. */
const ULAW_BYTES_PER_MS = 8;

/** Caller audio held while the socket is down, in u-law bytes (2 seconds). */
const MAX_PENDING_INPUT_BYTES = 16_000;

/** WebSocket.OPEN, spelled out so this module does not depend on the global. */
const WEBSOCKET_OPEN = 1;

/** A cancelled response only keeps arriving for a moment; 16 is plenty. */
const MAX_TRACKED_CANCELLED_RESPONSES = 16;

/** Longest close reason a WebSocket frame accepts is 123 bytes. */
const MAX_CLOSE_REASON_LENGTH = 100;

/**
 * Error codes that mean "this account cannot use Realtime at all". They are
 * never retried: retrying an entitlement problem just burns the caller's
 * patience.
 */
const TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set([
	"model_not_found",
	"invalid_model",
	"insufficient_quota",
	"beta_api_shape_disabled",
	"invalid_api_key",
]);

// ===========================================
// Wire shapes
// ===========================================

interface RealtimeUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	/**
	 * The breakdown that decides what a call actually costs.
	 *
	 * A Realtime turn re-reads the whole session prefix, so `input_tokens` grows
	 * with every turn and looks alarming on its own - one 83 second call summed to
	 * 76k. What matters is how much of that was served from cache (an order of
	 * magnitude cheaper) versus charged fresh, and how much was audio rather than
	 * text. Without this split there is no way to tell a prompt that is too long
	 * from a cache that is not being hit.
	 */
	input_token_details?: {
		cached_tokens?: number;
		text_tokens?: number;
		audio_tokens?: number;
		/** Always 0 on a voice call, but it is in the payload - see cached_tokens_details. */
		image_tokens?: number;
		/**
		 * How the cached prefix split across modalities.
		 *
		 * Confirmed on the live GA endpoint (gpt-realtime, 2026-08-06): a warm turn
		 * reported `cached_tokens: 6784` alongside
		 * `cached_tokens_details: { text_tokens: 6784, audio_tokens: 0,
		 * image_tokens: 0 }`, i.e. the cells reconstruct the marginal exactly.
		 * Reading them removes the apportionment the cost module would otherwise
		 * have to make - and because a third modality exists here, that module
		 * verifies the two cells still add up before trusting them.
		 */
		cached_tokens_details?: {
			text_tokens?: number;
			audio_tokens?: number;
			image_tokens?: number;
		};
	};
	output_token_details?: {
		text_tokens?: number;
		audio_tokens?: number;
	};
}

/**
 * One server event, flattened.
 *
 * The Realtime API has ~40 event types that share a small set of field names,
 * so a single optional-field shape is both smaller and safer than a union: the
 * handler for each `type` reads only the fields it needs and validates them,
 * and an event type this module does not know about cannot break parsing.
 */
interface RealtimeServerEvent {
	type: string;
	event_id?: string;
	delta?: string;
	transcript?: string;
	item_id?: string;
	response_id?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	/**
	 * Speech boundaries as OpenAI measures them: milliseconds into the input
	 * audio buffer, which is not the same origin as `call_transcripts.start_ms`
	 * (milliseconds from call start). They are deliberately not used for
	 * transcript timing - see elapsedMs().
	 */
	audio_start_ms?: number;
	audio_end_ms?: number;
	error?: {
		type?: string;
		code?: string | null;
		message?: string;
		param?: string | null;
	};
	session?: {
		id?: string;
		model?: string;
	};
	response?: {
		id?: string;
		status?: string;
		status_details?: unknown;
		usage?: RealtimeUsage;
	};
	/**
	 * Usage at the top level rather than under `response`.
	 *
	 * `conversation.item.input_audio_transcription.completed` carries it, and that
	 * is the ONLY report of what the separately-billed transcription model cost.
	 * Two shapes exist: `{type:"tokens", ...}` and `{type:"duration", seconds}`.
	 */
	usage?: {
		type?: string;
		input_tokens?: number;
		output_tokens?: number;
		seconds?: number;
		input_token_details?: {
			text_tokens?: number;
			audio_tokens?: number;
		};
	};
}

export interface OpenAiRealtimeProviderOptions {
	/**
	 * The business this session answers for.
	 *
	 * Supplying it is what makes the session business-specific: the voice, the
	 * spoken language, the advertised ticket categories, the system instructions
	 * and the greeting all come from it. Left out (a test, or a deployment with no
	 * profile row), the provider falls back to the environment and to a
	 * deliberately cautious unconfigured profile.
	 */
	agentProfile?: ActiveAgentProfile;
	/** Primed knowledge entries, quoted into the instructions as the only facts. */
	knowledge?: readonly KnowledgeHit[];
	/** Defaults to OPENAI_API_KEY. */
	apiKey?: string;
	/** Defaults to OPENAI_REALTIME_MODEL, then "gpt-realtime". */
	model?: string;
	/** Defaults to the profile's voice, then OPENAI_REALTIME_VOICE, then "alloy". */
	voice?: string;
	/** Defaults to wss://api.openai.com/v1/realtime. */
	baseUrl?: string;
	/** Input transcription model. `null` disables transcription entirely. */
	transcriptionModel?: string | null;
	/** "semantic_vad" (default) or "server_vad". */
	turnDetectionMode?: string;
	/** semantic_vad only: how quickly it decides the caller finished. Default "low". */
	vadEagerness?: string;
	/** Agent playback speed, 0.25..1.5. Default 0.95. */
	outputSpeed?: number;
	/** Ceiling on one generated reply. Default 1200. */
	maxOutputTokens?: number;
	/** Server VAD sensitivity, 0..1. Default 0.55. */
	vadThreshold?: number;
	/** Silence that ends a caller turn. Default 700 ms. */
	vadSilenceMs?: number;
	/** Audio kept from before the VAD trigger. Default 300 ms. */
	vadPrefixPaddingMs?: number;
	/** "near_field" | "far_field" | null to disable. Default "near_field". */
	noiseReduction?: string | null;
	/**
	 * How long a tool may run before the platform speaks a holding line. Default
	 * 400 ms; 0 disables the holding line entirely.
	 */
	toolAcknowledgementDelayMs?: number;
	/** Tools advertised to the model. Defaults to the profile's own categories. */
	tools?: readonly RealtimeToolDefinition[];
	/** Mid-call reconnect attempts. Default 3. start() never retries. */
	maxReconnectAttempts?: number;
	initialBackoffMs?: number;
	maxBackoffMs?: number;
	/** How long the handshake plus session setup may take. Default 10 s. */
	connectTimeoutMs?: number;
	readyGraceMs?: number;
	/**
	 * Speak the greeting as soon as the session is ready. Off by default: the
	 * orchestrator owns greeting timing (AI_AGENT_GREETING_DELAY_MS) and calls
	 * say(buildGreeting(ctx)) itself.
	 */
	autoGreeting?: boolean;
	/** Overridable so a test can assert on a fixed prompt. */
	buildInstructions?: (context: VoiceSessionContext) => string;
	buildGreetingText?: (context: VoiceSessionContext) => string;
	/**
	 * How the WebSocket is constructed. Defaults to Bun's, with the Authorization
	 * header; a test supplies a fake so the event handling can be driven without a
	 * network or an API key.
	 */
	socketFactory?: (url: string, options: { headers: Record<string, string> }) => WebSocket;
}

/** Where and as whom we connect. */
interface ResolvedConnectionOptions {
	apiKey: string;
	model: string;
	voice: string;
	baseUrl: string;
	transcriptionModel: string | null;
}

/** How the session behaves once it is up. */
interface ResolvedBehaviourOptions {
	agentProfile: ActiveAgentProfile;
	/** Kept past construction: the transcription hint is rebuilt per session.update. */
	knowledge: readonly KnowledgeHit[];
	turnDetectionMode: string;
	vadEagerness: string;
	outputSpeed: number;
	maxOutputTokens: number;
	vadThreshold: number;
	vadSilenceMs: number;
	vadPrefixPaddingMs: number;
	noiseReduction: string | null;
	toolAcknowledgementDelayMs: number;
	tools: readonly RealtimeToolDefinition[];
	maxReconnectAttempts: number;
	initialBackoffMs: number;
	maxBackoffMs: number;
	connectTimeoutMs: number;
	readyGraceMs: number;
	autoGreeting: boolean;
	buildInstructions: (context: VoiceSessionContext) => string;
	buildGreetingText: (context: VoiceSessionContext) => string;
	socketFactory: (url: string, options: { headers: Record<string, string> }) => WebSocket;
}

/**
 * The voice the caller hears.
 *
 * Precedence is deliberate: an explicit option (a test, a one-off) wins, then the
 * business's own configured voice, then the environment. The profile only wins
 * over .env when it is a real row - an unconfigured deployment keeps behaving
 * exactly as it did before profiles existed.
 */
function resolveVoice(options: OpenAiRealtimeProviderOptions): string {
	const explicit = options.voice?.trim();

	if (explicit !== undefined && explicit.length > 0) {
		return explicit;
	}

	const profile = options.agentProfile;
	const configured = profile?.isConfigured === true ? profile.voice.trim() : "";

	if (configured.length > 0) {
		return configured;
	}

	return process.env.OPENAI_REALTIME_VOICE ?? DEFAULT_VOICE;
}

/**
 * Environment is read here, per instance, rather than snapshotted at import
 * time - the same choice the ARI client makes, and what lets a test construct a
 * provider with an explicit key while production reads .env.
 */
function resolveConnectionOptions(
	options: OpenAiRealtimeProviderOptions
): ResolvedConnectionOptions {
	return {
		apiKey: (options.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim(),
		model: options.model ?? process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_MODEL,
		voice: resolveVoice(options),
		baseUrl: options.baseUrl ?? DEFAULT_REALTIME_URL,
		// `undefined` means "not specified" (use the env default); an explicit
		// `null` means "send no transcription block at all".
		transcriptionModel:
			options.transcriptionModel === undefined
				? (process.env.OPENAI_TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIPTION_MODEL)
				: options.transcriptionModel,
	};
}

/**
 * A number from the environment, or the default when it is unset or unusable.
 *
 * Bounds are not decoration: a threshold of 5 or a silence window of 50 ms would
 * be accepted by the API and would ruin every call on the deployment, and the
 * person editing .env at 2 a.m. is not going to read this file first.
 */
function readEnvNumber(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name];

	if (raw === undefined || raw.trim().length === 0) {
		return fallback;
	}

	const parsed = Number(raw);

	if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
		logger.warn(
			{ variable: name, value: raw, min, max, fallback },
			"ignoring an out-of-range Realtime tuning value from the environment"
		);
		return fallback;
	}

	return parsed;
}

/**
 * An explicit option, then the environment, then the default - with anything
 * outside `allowed` rejected loudly rather than sent to the API to be refused
 * mid-call.
 */
function readEnvChoice(
	name: string,
	explicit: string | undefined,
	allowed: ReadonlySet<string>,
	fallback: string
): string {
	const candidate = explicit ?? process.env[name];

	if (candidate === undefined || candidate.trim().length === 0) {
		return fallback;
	}

	const value = candidate.trim().toLowerCase();

	if (!allowed.has(value)) {
		logger.warn(
			{ variable: name, value: candidate, allowed: [...allowed], fallback },
			"ignoring an unknown Realtime tuning value from the environment"
		);
		return fallback;
	}

	return value;
}

/** "off" / "none" / "" disable it; an unknown value falls back to the default. */
function resolveNoiseReduction(option: string | null | undefined): string | null {
	if (option === null) {
		return null;
	}

	const raw = (option ?? process.env.OPENAI_REALTIME_NOISE_REDUCTION ?? "").trim().toLowerCase();

	if (raw.length === 0) {
		return DEFAULT_NOISE_REDUCTION;
	}

	if (raw === "off" || raw === "none" || raw === "false") {
		return null;
	}

	if (!NOISE_REDUCTION_TYPES.has(raw)) {
		logger.warn(
			{ value: raw, fallback: DEFAULT_NOISE_REDUCTION },
			"unknown noise reduction type, using the default"
		);
		return DEFAULT_NOISE_REDUCTION;
	}

	return raw;
}

/** VAD numbers, each overridable per deployment. Split out to keep the caller flat. */
function resolveTurnDetection(options: OpenAiRealtimeProviderOptions): {
	turnDetectionMode: string;
	vadEagerness: string;
	vadThreshold: number;
	vadSilenceMs: number;
	vadPrefixPaddingMs: number;
} {
	return {
		turnDetectionMode: readEnvChoice(
			"OPENAI_REALTIME_TURN_MODE",
			options.turnDetectionMode,
			TURN_DETECTION_MODES,
			DEFAULT_TURN_DETECTION_MODE
		),
		vadEagerness: readEnvChoice(
			"OPENAI_REALTIME_VAD_EAGERNESS",
			options.vadEagerness,
			VAD_EAGERNESS_LEVELS,
			DEFAULT_VAD_EAGERNESS
		),
		vadThreshold:
			options.vadThreshold ??
			readEnvNumber("OPENAI_REALTIME_VAD_THRESHOLD", DEFAULT_VAD_THRESHOLD, 0.1, 0.95),
		vadSilenceMs:
			options.vadSilenceMs ??
			readEnvNumber("OPENAI_REALTIME_VAD_SILENCE_MS", DEFAULT_VAD_SILENCE_MS, 200, 2_000),
		vadPrefixPaddingMs:
			options.vadPrefixPaddingMs ??
			readEnvNumber("OPENAI_REALTIME_VAD_PREFIX_MS", DEFAULT_VAD_PREFIX_PADDING_MS, 0, 1_000),
	};
}

/**
 * The two prompt builders, bound to the business.
 *
 * A caller can still override either one (that is how a test asserts on a fixed
 * prompt); the defaults are what make an unedited provider speak as the profile
 * rather than as a hardcoded hotline.
 */
function resolvePromptBuilders(
	options: OpenAiRealtimeProviderOptions,
	profile: ActiveAgentProfile,
	knowledge: readonly KnowledgeHit[]
): {
	buildInstructions: (context: VoiceSessionContext) => string;
	buildGreetingText: (context: VoiceSessionContext) => string;
} {
	return {
		buildInstructions:
			options.buildInstructions ??
			((context) => buildSystemInstructions(context, { profile, knowledge })),
		buildGreetingText: options.buildGreetingText ?? ((context) => buildGreeting(context, profile)),
	};
}

function resolveBehaviourOptions(options: OpenAiRealtimeProviderOptions): ResolvedBehaviourOptions {
	// One profile object for the whole session: the instructions, the greeting and
	// the advertised categories must all describe the same business, including
	// after a reconnect, which re-sends session.update from these same values.
	const profile = options.agentProfile ?? unconfiguredAgentProfile();
	const knowledge = options.knowledge ?? [];

	return {
		agentProfile: profile,
		knowledge,
		...resolveTurnDetection(options),
		...resolvePromptBuilders(options, profile, knowledge),
		noiseReduction: resolveNoiseReduction(options.noiseReduction),
		outputSpeed:
			options.outputSpeed ??
			readEnvNumber("OPENAI_REALTIME_SPEED", DEFAULT_OUTPUT_SPEED, 0.25, 1.5),
		maxOutputTokens:
			options.maxOutputTokens ??
			readEnvNumber("OPENAI_REALTIME_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS, 100, 8_000),
		toolAcknowledgementDelayMs:
			options.toolAcknowledgementDelayMs ??
			readEnvNumber(
				"OPENAI_REALTIME_TOOL_FILLER_MS",
				DEFAULT_TOOL_ACKNOWLEDGEMENT_DELAY_MS,
				0,
				5_000
			),
		tools: options.tools ?? buildToolDefinitions(profile.ticketCategories),
		maxReconnectAttempts: Math.max(
			0,
			options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
		),
		initialBackoffMs: options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
		maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
		connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
		readyGraceMs: options.readyGraceMs ?? DEFAULT_READY_GRACE_MS,
		autoGreeting: options.autoGreeting ?? false,
		socketFactory:
			options.socketFactory ?? ((url, socketOptions) => new BunWebSocket(url, socketOptions)),
	};
}

/** In-flight connection attempt, so a message handler can settle it. */
interface PendingAttempt {
	socket: WebSocket;
	resolve: () => void;
	reject: (error: Error) => void;
	settled: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Bun's WebSocket takes a second options argument carrying request headers -
 * that is the only way to get `Authorization` onto the upgrade request, and
 * OpenAI accepts nothing else.
 *
 * The cast is needed because lib.dom is in this program's type graph (a
 * dependency pulls it in), so the ambient `WebSocket` constructor is typed with
 * the browser's `(url, protocols)` form, which has no headers at all. The
 * runtime is Bun, which does support them; the alias re-states Bun's own
 * signature instead of scattering `as any` over the call sites.
 */
type HeaderAwareWebSocketConstructor = new (
	url: string,
	options: { headers: Record<string, string> }
) => WebSocket;

const BunWebSocket = WebSocket as unknown as HeaderAwareWebSocketConstructor;

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	return value.length === 0 ? null : value;
}

/**
 * The primary language subtag, which is what a transcription model wants.
 *
 * AI_AGENT_LANGUAGE is documented as "BCP-47-ish", so it can arrive as "uz",
 * "uz-UZ" or "uz_Latn". Whisper and the gpt-4o transcribers take ISO-639-1, and
 * silently ignore anything longer, so only the subtag is sent.
 */
function transcriptionLanguage(language: string): string | null {
	const primary = language.trim().toLowerCase().split(/[-_]/)[0] ?? "";

	return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/**
 * Transcription languages the API has refused, per transcription model.
 *
 * Learned at runtime rather than hardcoded: the supported set belongs to the
 * transcription model and differs between them, so a list baked in here would go
 * stale. Process-wide because the answer does not change between calls - without
 * it every call re-sent a value already known to be invalid and paid for a second
 * session.update (measured at ~1.3 s of extra setup on an Uzbek deployment, where
 * whisper-1 rejects 'uz').
 */
const rejectedTranscriptionLanguages = new Map<string, Set<string>>();

function isTranscriptionLanguageRejected(model: string, language: string): boolean {
	return rejectedTranscriptionLanguages.get(model)?.has(language) === true;
}

function rememberRejectedTranscriptionLanguage(model: string, language: string): void {
	const known = rejectedTranscriptionLanguages.get(model);

	if (known === undefined) {
		rejectedTranscriptionLanguages.set(model, new Set([language]));
		return;
	}

	known.add(language);
}

/**
 * Whether an API error is complaining about this optional session field.
 *
 * `param` is trusted as a path when the API sends one. A message is only matched
 * against markers specific enough to be unambiguous - "language" on its own
 * appears in unrelated errors, so it is never matched against free text.
 */
function matchesSessionExtra(extra: SessionExtra, message: string, param: string | null): boolean {
	const markers = SESSION_EXTRA_MARKERS[extra];
	const haystackParam = (param ?? "").toLowerCase();
	const haystackMessage = message.toLowerCase();

	for (const marker of markers) {
		if (haystackParam.length > 0 && haystackParam.includes(marker)) {
			return true;
		}

		const isSpecific = marker.includes("_") || marker.includes(".");

		if (isSpecific && haystackMessage.includes(marker)) {
			return true;
		}
	}

	return false;
}

/** `response.cancel` with nothing in flight is a race, not a fault. */
function isBenignCancelRace(code: string | null, message: string): boolean {
	if (code === "response_cancel_not_active") {
		return true;
	}
	return /no active response|cancellation failed/i.test(message);
}

/**
 * "A response is already in progress" - recoverable by waiting, not by failing.
 *
 * Worth detecting separately because the fix is to re-queue the turn: reported as
 * a plain error it would show up on the dashboard as a session fault while the
 * call was in fact fine.
 */
function isActiveResponseConflict(code: string | null, message: string): boolean {
	if (code === "conversation_already_has_active_response") {
		return true;
	}
	return /already has an active response|active response in progress/i.test(message);
}

/**
 * Parse one server frame.
 *
 * Returns null for anything that is not a JSON object carrying a string `type`,
 * which is the only shape the rest of this module knows how to handle. A
 * malformed frame is logged and dropped: it must never take the session down.
 */
function parseRealtimeEvent(data: unknown): RealtimeServerEvent | null {
	if (typeof data !== "string") {
		logger.debug("ignoring a non-text frame from the Realtime API");
		return null;
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(data);
	} catch (cause) {
		logger.error({ err: cause, preview: data.slice(0, 200) }, "unparseable Realtime event");
		return null;
	}

	if (parsed === null || typeof parsed !== "object") {
		return null;
	}

	const event = parsed as RealtimeServerEvent;

	return typeof event.type === "string" ? event : null;
}

/**
 * The arguments object from a `response.function_call_arguments.done` event.
 *
 * A model that streams malformed JSON is a normal event, not a fault, so this
 * reports the problem instead of throwing: the text goes back as the tool result
 * and the model gets to correct itself on the next turn.
 */
function parseToolArguments(
	raw: unknown
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
	const text = typeof raw === "string" ? raw.trim() : "";

	if (text.length === 0) {
		// A tool with no required parameters is legitimately called with nothing.
		return { ok: true, args: {} };
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		return { ok: false, error: `arguments were not valid JSON: ${toError(cause).message}` };
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "arguments were not a JSON object" };
	}

	return { ok: true, args: parsed as Record<string, unknown> };
}

/** One line, no runs of whitespace, capped. Read by a model, not by a human. */
function oneLine(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();

	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Frame a tool result so it can be understood but not recited.
 *
 * The problem this solves was audible on the line: a rejected tool call comes
 * back as `{ ok: false, error: <zod's prettified message> }`, which is several
 * lines of English naming fields and expected types. Handed to a speech model as
 * an unlabelled blob, that text is the most concrete thing in its context, and
 * the model reads it to the caller - who hears an English stack of field names
 * from a municipal hotline.
 *
 * So every result is wrapped: the error text is collapsed to one capped line
 * (a wall of text invites recitation, a short line invites paraphrase) and a
 * `guidance` field states plainly that none of it may be spoken. When the
 * orchestrator has already supplied its own `message` telling the model what to
 * say next, that instruction is left to drive the recovery and only the
 * do-not-read-this reminder is added - two conflicting recovery instructions are
 * worse than one.
 */
function serialiseToolResult(result: unknown): string {
	const envelope = buildToolResultEnvelope(result);

	try {
		return JSON.stringify(envelope);
	} catch (cause) {
		logger.warn({ err: cause }, "tool result was not serialisable, sending a plain summary");

		return JSON.stringify({
			ok: false,
			error: "the result could not be encoded",
			guidance: TOOL_FAILURE_GUIDANCE,
		});
	}
}

/** Exported for the tests: the shape a tool result reaches the model in. */
export function buildToolResultEnvelope(result: unknown): Record<string, unknown> {
	if (result === null || result === undefined) {
		return { ok: true, guidance: TOOL_RESULT_GUIDANCE };
	}

	if (typeof result === "string") {
		// No `ok` is invented here: a bare string carries no verdict, and guessing
		// one would make a failure sound like a success.
		return { note: oneLine(result, MAX_TOOL_ERROR_CHARS), guidance: TOOL_RESULT_GUIDANCE };
	}

	if (typeof result !== "object" || Array.isArray(result)) {
		return { value: result, guidance: TOOL_RESULT_GUIDANCE };
	}

	const source = result as Record<string, unknown>;
	const envelope: Record<string, unknown> = { ...source };
	const failed = source.ok === false;

	if (typeof source.error === "string") {
		envelope.error = oneLine(source.error, MAX_TOOL_ERROR_CHARS);
	}

	if (typeof source.message === "string") {
		envelope.message = oneLine(source.message, MAX_TOOL_ERROR_CHARS);
	}

	if (typeof source.guidance !== "string") {
		const hasOwnRecovery = typeof source.message === "string" && source.message.length > 0;

		envelope.guidance = failed && !hasOwnRecovery ? TOOL_FAILURE_GUIDANCE : TOOL_RESULT_GUIDANCE;
	}

	return envelope;
}

// ===========================================
// Provider
// ===========================================

class OpenAiRealtimeProvider implements VoiceProvider {
	readonly name = OPENAI_REALTIME_PROVIDER_NAME;

	private readonly apiKey: string;
	/** Public so ai_sessions records the model this session really used, not the environment's. */
	readonly model: string;
	/**
	 * Public for the same reason `model` is: ai_sessions must record the voice the
	 * caller actually heard. Reconstructing it from the profile recorded a Gemini
	 * voice against an OpenAI session whenever the provider had been switched.
	 */
	readonly voice: string;
	private readonly baseUrl: string;
	private readonly transcriptionModel: string | null;
	private readonly agentProfile: ActiveAgentProfile;
	private readonly knowledge: readonly KnowledgeHit[];
	private readonly turnDetectionMode: string;
	private readonly vadEagerness: string;
	private readonly outputSpeed: number;
	private readonly maxOutputTokens: number;
	private readonly vadThreshold: number;
	private readonly vadSilenceMs: number;
	private readonly vadPrefixPaddingMs: number;
	private readonly noiseReduction: string | null;
	private readonly toolAcknowledgementDelayMs: number;
	private readonly tools: readonly RealtimeToolDefinition[];
	private readonly maxReconnectAttempts: number;
	private readonly initialBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly connectTimeoutMs: number;
	private readonly readyGraceMs: number;
	private readonly autoGreeting: boolean;
	private readonly buildInstructions: (context: VoiceSessionContext) => string;
	private readonly buildGreetingText: (context: VoiceSessionContext) => string;
	private readonly socketFactory: (
		url: string,
		options: { headers: Record<string, string> }
	) => WebSocket;

	private context: VoiceSessionContext | null = null;
	private handlers: VoiceProviderHandlers | null = null;

	private socket: WebSocket | null = null;
	private pending: PendingAttempt | null = null;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;

	private startedAtMs = 0;
	private sessionCreated = false;
	private sessionReady = false;
	private hasBeenReady = false;
	private stopped = false;
	private closeEmitted = false;

	/** Set once an error means this account can never open a session. */
	private terminal: { code: string; message: string } | null = null;

	private activeResponseId: string | null = null;
	/** The response whose audio was handed over most recently. */
	private lastAudioResponseId: string | null = null;
	private readonly cancelledResponses = new Set<string>();

	/**
	 * Optional `session.update` fields still believed to be supported. Emptied
	 * one field at a time when the API rejects one.
	 */
	private readonly sessionExtras = new Set<SessionExtra>();
	private sessionDegradations = 0;

	/** Transcription language actually sent, so a rejection can name the value. */
	private sentTranscriptionLanguage: string | null = null;
	/** Decoding hint actually sent, so an echo of it can be recognised and dropped. */
	private sentTranscriptionPrompt: string | null = null;

	/**
	 * Serialises `response.create`.
	 *
	 * The API allows exactly one response at a time: a second create while one is
	 * running is answered with an error and the turn is simply lost - which on the
	 * line is the agent going quiet after a tool call. Every path that wants the
	 * model to speak (a platform line, a tool result, a holding line) goes through
	 * requestResponse(), and anything asked for while a response is running waits
	 * for its `response.done`.
	 */
	private awaitingResponseCreated = false;
	private pendingResponseReason: string | null = null;
	private pendingResponseTimer: ReturnType<typeof setTimeout> | null = null;

	/** Lines to speak once the session is ready (a say() that arrived too early). */
	private readonly pendingSayLines: string[] = [];

	/** The tool call in flight, for the holding-line decision. */
	private pendingTool: { name: string; requestedAtMs: number; acknowledged: boolean } | null = null;
	private toolFillerTimer: ReturnType<typeof setTimeout> | null = null;

	/** True once the response in flight has produced any audio of its own. */
	private responseProducedAudio = false;

	/**
	 * Wall clock at which the audio handed over so far finishes playing.
	 *
	 * Deltas arrive far faster than real time, so `response.done` says nothing
	 * about whether the caller can still hear the agent. This horizon does, and it
	 * is what makes barge-in work for a turn the model has already finished
	 * generating.
	 */
	private playbackHorizonMs = 0;

	/**
	 * Per-role transcript streams. They guarantee one final line per turn and
	 * suppress the interim events that would otherwise be persisted as a
	 * duplicate of it - see turn-transcript.ts.
	 */
	private readonly agentTranscript = new TurnTranscriptStream();
	private readonly callerTranscript = new TurnTranscriptStream();

	/** Decoded agent audio waiting to be handed to the orchestrator. */
	private readonly outboundQueue: Buffer[] = [];
	private deliveringAudio = false;

	/** Caller audio captured while the socket was not usable. */
	private readonly pendingInput: Buffer[] = [];
	private pendingInputBytes = 0;

	private inputUlawBytes = 0;
	private outputUlawBytes = 0;
	private interruptionCount = 0;

	private callerUtteranceStartMs: number | null = null;
	private agentResponseStartMs: number | null = null;

	/** True between `speech_started` and the caller's turn being committed. */
	private callerSpeaking = false;
	/** Armed after a barge-in so a killed turn cannot leave the line silent. */
	private bargeInRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Set while the closing line is being spoken; noise must not cancel it. */
	private bargeInSuppressed = false;

	private readonly sentToolResults = new Set<string>();

	constructor(options: OpenAiRealtimeProviderOptions = {}) {
		const connection = resolveConnectionOptions(options);
		const behaviour = resolveBehaviourOptions(options);

		this.apiKey = connection.apiKey;
		this.model = connection.model;
		this.voice = connection.voice;
		this.baseUrl = connection.baseUrl;
		this.transcriptionModel = connection.transcriptionModel;

		this.agentProfile = behaviour.agentProfile;
		this.knowledge = behaviour.knowledge;
		this.turnDetectionMode = behaviour.turnDetectionMode;
		this.vadEagerness = behaviour.vadEagerness;
		this.outputSpeed = behaviour.outputSpeed;
		this.maxOutputTokens = behaviour.maxOutputTokens;
		this.vadThreshold = behaviour.vadThreshold;
		this.vadSilenceMs = behaviour.vadSilenceMs;
		this.vadPrefixPaddingMs = behaviour.vadPrefixPaddingMs;
		this.noiseReduction = behaviour.noiseReduction;
		this.toolAcknowledgementDelayMs = behaviour.toolAcknowledgementDelayMs;
		this.tools = behaviour.tools;
		this.maxReconnectAttempts = behaviour.maxReconnectAttempts;
		this.initialBackoffMs = behaviour.initialBackoffMs;
		this.maxBackoffMs = behaviour.maxBackoffMs;
		this.connectTimeoutMs = behaviour.connectTimeoutMs;
		this.readyGraceMs = behaviour.readyGraceMs;
		this.autoGreeting = behaviour.autoGreeting;
		this.buildInstructions = behaviour.buildInstructions;
		this.buildGreetingText = behaviour.buildGreetingText;
		this.socketFactory = behaviour.socketFactory;

		if (this.noiseReduction !== null) {
			this.sessionExtras.add("noise_reduction");
		}

		this.sessionExtras.add("prefix_padding");
		this.sessionExtras.add("output_speed");
		this.sessionExtras.add("max_output_tokens");

		if (this.turnDetectionMode === "semantic_vad") {
			this.sessionExtras.add("turn_detection_mode");

			// semantic_vad accepts only eagerness/create_response/interrupt_response,
			// so the three tuned server_vad numbers are not sent at all. They are still
			// read and range-checked, which means an operator can set
			// OPENAI_REALTIME_VAD_THRESHOLD, see it validated, and never learn it did
			// nothing. Say so once, only when they actually asked for a value.
			const overridden = [
				"OPENAI_REALTIME_VAD_THRESHOLD",
				"OPENAI_REALTIME_VAD_SILENCE_MS",
				"OPENAI_REALTIME_VAD_PREFIX_MS",
			].filter((name) => (process.env[name] ?? "").trim().length > 0);

			if (overridden.length > 0) {
				logger.warn(
					{ ignored: overridden, mode: this.turnDetectionMode },
					"these tune server_vad only and are ignored under semantic_vad; set OPENAI_REALTIME_TURN_MODE=server_vad to use them"
				);
			}
		}

		if (this.transcriptionModel !== null) {
			this.sessionExtras.add("transcription_language");
		}
	}

	// -----------------------------------------
	// VoiceProvider
	// -----------------------------------------

	async start(context: VoiceSessionContext, handlers: VoiceProviderHandlers): Promise<void> {
		if (this.handlers !== null) {
			throw new Error("OpenAI Realtime provider instances handle exactly one call");
		}

		if (this.apiKey.length === 0) {
			throw new VoiceProviderUnavailableError(
				this.name,
				"OPENAI_API_KEY is not set, so no Realtime session can be opened"
			);
		}

		this.context = context;
		this.handlers = handlers;
		this.startedAtMs = Date.now();

		logger.info(
			{
				callId: context.callId,
				channelId: context.channelId,
				model: this.model,
				voice: this.voice,
				business: this.agentProfile.businessName,
				configured: this.agentProfile.isConfigured,
			},
			"opening an OpenAI Realtime session"
		);

		try {
			await this.openSocket();
		} catch (cause) {
			// A failed start is reported by throwing, never by onClose: the
			// orchestrator has not been handed a working session to close.
			this.stopped = true;
			this.closeEmitted = true;
			this.clearTimers();

			const error = toError(cause);

			if (error instanceof VoiceProviderUnavailableError) {
				throw error;
			}

			throw new VoiceProviderUnavailableError(
				this.name,
				`could not open an OpenAI Realtime session: ${error.message}`,
				error
			);
		}
	}

	pushAudio(slin8k: Buffer): void {
		if (this.stopped || slin8k.length === 0) {
			return;
		}

		const ulaw = muLawEncode(slin8k);

		if (ulaw.length === 0) {
			return;
		}

		// Counted on the way in, so the figure stays a measure of how much the
		// caller spoke even across a reconnect.
		this.inputUlawBytes += ulaw.length;

		if (this.canSendAudio()) {
			this.flushPendingInput();
			this.sendAudioAppend(ulaw);
			return;
		}

		this.pendingInput.push(ulaw);
		this.pendingInputBytes += ulaw.length;

		while (this.pendingInputBytes > MAX_PENDING_INPUT_BYTES) {
			const dropped = this.pendingInput.shift();

			if (dropped === undefined) {
				this.pendingInputBytes = 0;
				break;
			}

			this.pendingInputBytes -= dropped.length;
		}
	}

	say(text: string): void {
		const trimmed = text.trim();

		if (trimmed.length === 0) {
			return;
		}

		if (!this.sessionReady) {
			// The greeting is the usual arrival here, on a session that is still
			// negotiating or has just dropped. Dropping it would leave the caller
			// listening to nothing after a connect, so it is held instead.
			if (this.pendingSayLines.length < MAX_PENDING_SAY_LINES) {
				this.pendingSayLines.push(trimmed);
			}

			logger.debug(
				{ held: this.pendingSayLines.length },
				"holding a line until the session is ready"
			);
			return;
		}

		// Only user-role items accept input_text on the GA wire, so a line the
		// platform wants spoken is injected as a text turn wrapped in the
		// [SYSTEM] directive that prompts.ts teaches the model to read verbatim.
		this.send({
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: formatSayDirective(trimmed) }],
			},
		});
		this.requestResponse("say");
	}

	cancelResponse(): void {
		this.abandonCurrentResponse("cancelled");
	}

	sendToolResult(toolCallId: string, result: unknown): void {
		if (this.sentToolResults.has(toolCallId)) {
			logger.debug({ toolCallId }, "tool result already sent, ignoring the duplicate");
			return;
		}

		this.sentToolResults.add(toolCallId);
		// The result is here, so a holding line would now be spoken over the answer.
		this.clearPendingTool();

		this.send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: toolCallId,
				output: serialiseToolResult(result),
			},
		});
		// The model does not continue on its own after a tool result.
		this.requestResponse("tool_result");
	}

	stop(reason: string): Promise<void> {
		if (this.stopped) {
			return Promise.resolve();
		}

		this.stopped = true;
		this.clearTimers();

		// A call cut off mid-sentence still said what it said. Flushing the open
		// turn keeps that last line in the stored transcript instead of losing it
		// with the session.
		this.flushOpenTranscriptTurns();

		const socket = this.socket;

		if (socket !== null) {
			if (this.activeResponseId !== null) {
				this.send({ type: "response.cancel", response_id: this.activeResponseId });
			}

			this.socket = null;
			this.closeSocket(socket, reason);
		}

		this.sessionReady = false;
		this.sessionCreated = false;
		this.activeResponseId = null;
		this.awaitingResponseCreated = false;
		this.pendingResponseReason = null;
		this.outboundQueue.length = 0;
		this.pendingInput.length = 0;
		this.pendingInputBytes = 0;
		this.pendingSayLines.length = 0;
		this.playbackHorizonMs = 0;
		this.callerSpeaking = false;
		this.agentTranscript.reset();
		this.callerTranscript.reset();

		logger.info(
			{ callId: this.context?.callId ?? null, reason, ...this.stats() },
			"OpenAI Realtime session stopped"
		);

		this.finish(reason);
		return Promise.resolve();
	}

	stats(): VoiceProviderStats {
		return {
			inputAudioMs: Math.round(this.inputUlawBytes / ULAW_BYTES_PER_MS),
			outputAudioMs: Math.round(this.outputUlawBytes / ULAW_BYTES_PER_MS),
			interruptions: this.interruptionCount,
		};
	}

	// -----------------------------------------
	// Connection
	// -----------------------------------------

	private openSocket(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = `${this.baseUrl}?model=${encodeURIComponent(this.model)}`;
			let socket: WebSocket;

			try {
				// ONLY the Authorization header. An OpenAI-Beta header here is fatal.
				socket = this.socketFactory(url, {
					headers: { Authorization: `Bearer ${this.apiKey}` },
				});
			} catch (cause) {
				reject(toError(cause));
				return;
			}

			this.socket = socket;

			const pending: PendingAttempt = { socket, resolve, reject, settled: false, timer: null };
			pending.timer = setTimeout(() => {
				this.settleAttempt(
					socket,
					new Error(`the Realtime handshake did not complete within ${this.connectTimeoutMs} ms`)
				);
				this.abandonSocket(socket, "handshake timeout");
			}, this.connectTimeoutMs);
			this.pending = pending;

			socket.onopen = () => {
				if (this.socket !== socket) {
					return;
				}
				// The five settings that decide how the agent sounds and what it costs.
				// Logged at open because they are resolved from three places - explicit
				// option, environment, default - and "which one actually took effect" is
				// otherwise only answerable by reading a packet capture.
				logger.info(
					{
						model: this.model,
						voice: this.voice,
						speed: this.outputSpeed,
						turnDetection: this.turnDetectionMode,
						eagerness: this.turnDetectionMode === "semantic_vad" ? this.vadEagerness : null,
						maxOutputTokens: this.maxOutputTokens,
						transcription: this.transcriptionModel,
					},
					"Realtime socket open, sending session.update"
				);
				this.sendSessionUpdate();
			};

			socket.onmessage = (event: MessageEvent) => {
				if (this.socket !== socket) {
					return;
				}
				this.handleMessage(event.data, socket);
			};

			socket.onerror = () => {
				// The browser-style API carries no detail here; onclose has the code.
				logger.warn({ model: this.model }, "Realtime socket reported an error");
			};

			socket.onclose = (event: CloseEvent) => {
				this.handleClose(socket, event.code, event.reason ?? "");
			};
		});
	}

	private settleAttempt(socket: WebSocket, error: Error | null): void {
		const pending = this.pending;

		if (pending === null || pending.socket !== socket || pending.settled) {
			return;
		}

		pending.settled = true;

		if (pending.timer !== null) {
			clearTimeout(pending.timer);
		}

		this.pending = null;

		if (error === null) {
			pending.resolve();
			return;
		}

		pending.reject(error);
	}

	private handleClose(socket: WebSocket, code: number, reason: string): void {
		const wasCurrent = this.socket === socket;
		const wasPending = this.pending?.socket === socket;

		if (!(wasCurrent || wasPending)) {
			return;
		}

		if (wasCurrent) {
			this.socket = null;
		}

		this.sessionCreated = false;
		this.sessionReady = false;
		this.activeResponseId = null;
		this.clearReadyTimer();

		// The socket carried the conversation state, so nothing queued for it can be
		// delivered: a response.create would be sent into a closed socket, and the
		// gate must not stay shut for the reconnected session.
		this.awaitingResponseCreated = false;
		this.pendingResponseReason = null;
		this.clearPendingResponseTimer();
		this.clearPendingTool();
		this.outboundQueue.length = 0;
		this.playbackHorizonMs = 0;
		this.callerSpeaking = false;

		// Whatever the agent was half-way through saying was still said.
		this.flushOpenTranscriptTurns();

		logger.debug({ code, reason }, "Realtime socket closed");

		if (wasPending) {
			// The attempt is still awaited: reject it and let start() or the
			// reconnect loop decide what happens next.
			this.settleAttempt(socket, this.buildCloseError(code, reason));
			return;
		}

		if (this.stopped) {
			return;
		}

		if (this.terminal !== null) {
			this.emitError(this.buildUnavailableError());
			this.finish("provider_unavailable");
			return;
		}

		if (code === 1000) {
			logger.info({ reason }, "OpenAI closed the Realtime session normally");
			this.finish(reason.length > 0 ? reason : "remote_closed");
			return;
		}

		this.scheduleReconnect(code, reason);
	}

	private buildCloseError(code: number, reason: string): Error {
		if (this.terminal !== null) {
			return this.buildUnavailableError();
		}

		const detail = reason.length > 0 ? `: ${reason}` : "";

		return new Error(
			`the Realtime socket closed before the session was ready (code ${code}${detail})`
		);
	}

	private buildUnavailableError(): VoiceProviderUnavailableError {
		const terminal = this.terminal;
		const detail =
			terminal === null
				? "the Realtime API is not available for this account"
				: `${terminal.message} (code ${terminal.code})`;

		return new VoiceProviderUnavailableError(this.name, `model ${this.model}: ${detail}`);
	}

	private scheduleReconnect(code: number, reason: string): void {
		if (this.stopped || this.reconnectTimer !== null) {
			return;
		}

		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			const detail = reason.length > 0 ? `: ${reason}` : "";

			this.emitError(
				new Error(
					`the OpenAI Realtime session dropped (code ${code}${detail}) and could not be re-established after ${this.reconnectAttempts} attempt(s)`
				)
			);
			this.finish("reconnect_failed");
			return;
		}

		this.reconnectAttempts += 1;

		const ceiling = Math.min(
			this.maxBackoffMs,
			this.initialBackoffMs * 2 ** (this.reconnectAttempts - 1)
		);
		// Full jitter with a floor, so several calls dropping at once do not
		// reconnect in lockstep and a refused port cannot spin.
		const delayMs = Math.max(Math.round(ceiling / 4), Math.round(Math.random() * ceiling));

		logger.warn(
			{ attempt: this.reconnectAttempts, delayMs, code, reason },
			"reconnecting the OpenAI Realtime session"
		);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;

			if (this.stopped) {
				return;
			}

			this.openSocket()
				.then(() => {
					logger.info({ attempt: this.reconnectAttempts }, "OpenAI Realtime session restored");
				})
				.catch((cause: unknown) => {
					const error = toError(cause);

					logger.warn(
						{ err: error, attempt: this.reconnectAttempts },
						"OpenAI Realtime reconnect attempt failed"
					);

					if (this.terminal !== null) {
						this.emitError(this.buildUnavailableError());
						this.finish("provider_unavailable");
						return;
					}

					this.scheduleReconnect(code, reason);
				});
		}, delayMs);
	}

	private abandonSocket(socket: WebSocket, reason: string): void {
		if (this.socket === socket) {
			this.socket = null;
		}

		this.sessionCreated = false;
		this.sessionReady = false;
		this.closeSocket(socket, reason);
	}

	private closeSocket(socket: WebSocket, reason: string): void {
		// Detach first: a close we asked for must not re-enter handleClose and
		// schedule a reconnect.
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;

		try {
			socket.close(1000, reason.slice(0, MAX_CLOSE_REASON_LENGTH));
		} catch (cause) {
			logger.debug({ err: cause }, "closing the Realtime socket threw, ignoring");
		}
	}

	private clearReadyTimer(): void {
		if (this.readyTimer !== null) {
			clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}
	}

	private clearTimers(): void {
		this.clearReadyTimer();

		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		if (this.pendingResponseTimer !== null) {
			clearTimeout(this.pendingResponseTimer);
			this.pendingResponseTimer = null;
		}

		if (this.toolFillerTimer !== null) {
			clearTimeout(this.toolFillerTimer);
			this.toolFillerTimer = null;
		}
	}

	// -----------------------------------------
	// Sending
	// -----------------------------------------

	private canSend(): boolean {
		return this.socket !== null && this.socket.readyState === WEBSOCKET_OPEN;
	}

	/**
	 * Audio appends are only legal once the session exists: anything sent between
	 * the socket opening and `session.created` is rejected, so caller audio from
	 * that window is buffered instead of thrown away.
	 */
	private canSendAudio(): boolean {
		return this.sessionCreated && this.canSend();
	}

	private send(payload: Record<string, unknown>): void {
		const socket = this.socket;

		if (socket === null || socket.readyState !== WEBSOCKET_OPEN) {
			logger.debug({ type: payload.type }, "dropping a Realtime event: socket is not open");
			return;
		}

		try {
			socket.send(JSON.stringify(payload));
		} catch (cause) {
			const error = toError(cause);
			logger.error({ err: error, type: payload.type }, "failed to send a Realtime event");
			this.emitError(error);
		}
	}

	/**
	 * The GA session configuration. Also re-sent after a reconnect, which is
	 * what "restore the session config" means: a new socket is a new session,
	 * with none of the instructions, tools or audio formats carried over.
	 */
	/**
	 * How the API decides the caller has finished talking.
	 *
	 * `semantic_vad` asks a model whether the sentence sounds finished, instead of
	 * counting milliseconds of silence. On a phone line that is the difference
	 * between a colleague and a kiosk: a caller who pauses to think ("manzil...
	 * ha, Chilonzor") is no longer cut off, and the agent stops answering the first
	 * half of a sentence.
	 *
	 * It is also the cheapest change available. A measured 147-second call ran 16
	 * turns with 3 of them interrupted - and every interrupted turn is a full
	 * response generated, paid for, and never heard, plus another whole prefix
	 * re-read for the retry.
	 *
	 * `server_vad` remains the fallback: it is what an older deployment or a
	 * stricter account may be limited to, and `turn_detection_mode` drops out of
	 * sessionExtras if the API rejects the semantic shape.
	 */
	private buildTurnDetection(): Record<string, unknown> {
		if (
			this.turnDetectionMode === "semantic_vad" &&
			this.sessionExtras.has("turn_detection_mode")
		) {
			return {
				type: "semantic_vad",
				// "low" waits longest before deciding the caller is done. On 8 kHz
				// telephony, with dialect and thinking pauses, being slow to jump in is
				// worth far more than shaving half a second off the reply.
				eagerness: this.vadEagerness,
				create_response: true,
				interrupt_response: true,
			};
		}

		const turnDetection: Record<string, unknown> = {
			type: "server_vad",
			threshold: this.vadThreshold,
			silence_duration_ms: this.vadSilenceMs,
		};

		if (this.sessionExtras.has("prefix_padding")) {
			turnDetection.prefix_padding_ms = this.vadPrefixPaddingMs;
		}

		return turnDetection;
	}

	private sendSessionUpdate(): void {
		const context = this.context;

		if (context === null) {
			return;
		}

		const turnDetection = this.buildTurnDetection();

		const input: Record<string, unknown> = {
			format: { type: "audio/pcmu" },
			turn_detection: turnDetection,
		};

		if (this.noiseReduction !== null && this.sessionExtras.has("noise_reduction")) {
			input.noise_reduction = { type: this.noiseReduction };
		}

		if (this.transcriptionModel !== null) {
			const transcription: Record<string, unknown> = { model: this.transcriptionModel };
			// The call's language when the orchestrator resolved one (it takes it from
			// the profile), the business's own language otherwise.
			const language =
				transcriptionLanguage(context.language) ??
				transcriptionLanguage(this.agentProfile.language);

			// Pinning the transcriber's language is worth more here than anywhere else
			// in the stack: on 8 kHz audio a language-guessing transcriber regularly
			// decides Uzbek is Turkish or Azeri, and every district and street name in
			// the transcript comes out wrong.
			//
			// It is only sent when the model has not already refused it. Not every
			// language the agent can *speak* is one the transcriber accepts - whisper-1
			// rejects 'uz' outright - and re-sending a known-bad value would cost a
			// second session.update on every single call.
			const usable =
				language !== null &&
				this.sessionExtras.has("transcription_language") &&
				!isTranscriptionLanguageRejected(this.transcriptionModel, language);

			this.sentTranscriptionLanguage = usable ? language : null;

			if (usable) {
				transcription.language = language;
			}

			// The decoding hint. This is what actually carries Uzbek, because the
			// `language` field above can never say so - the API's supported-language
			// list has no 'uz' for ANY transcription model (verified against the live
			// endpoint). Without a hint the decoder guesses per syllable and on 8 kHz
			// telephony audio it produced Greek text for Uzbek speech.
			const prompt = buildTranscriptionPrompt(this.agentProfile, this.knowledge);

			this.sentTranscriptionPrompt = prompt;

			if (prompt !== null) {
				transcription.prompt = prompt;
			}

			input.transcription = transcription;
		}

		const output: Record<string, unknown> = {
			format: { type: "audio/pcmu" },
			voice: this.voice,
		};

		if (this.sessionExtras.has("output_speed")) {
			output.speed = this.outputSpeed;
		}

		const session: Record<string, unknown> = {
			type: "realtime",
			output_modalities: ["audio"],
			instructions: this.buildInstructions(context),
			audio: { input, output },
			// record_call_outcome is appended here, not in the constructor: whether this
			// is a campaign call is a fact about the call, not about the business.
			tools: toolsForCall(this.tools, context),
			tool_choice: "auto",
		};

		// A ceiling on one reply, not a budget for the call. Generated speech is the
		// priciest line on the bill and the only one a misbehaving turn can run away
		// with; every other limit in this file is about time, not tokens.
		if (this.sessionExtras.has("max_output_tokens")) {
			session.max_output_tokens = this.maxOutputTokens;
		}

		this.send({ type: "session.update", session });
	}

	/**
	 * Drop the optional session field an API error is complaining about and send
	 * the configuration again.
	 *
	 * @returns true when something was dropped and a retry was sent.
	 */
	private degradeSession(code: string | null, message: string, param: string | null): boolean {
		if (this.sessionDegradations >= MAX_SESSION_DEGRADATIONS) {
			return false;
		}

		const isParameterComplaint =
			param !== null ||
			code === "unknown_parameter" ||
			code === "invalid_value" ||
			/unknown|unexpected|not supported|invalid/i.test(message);

		if (!isParameterComplaint) {
			return false;
		}

		for (const extra of this.sessionExtras) {
			if (!matchesSessionExtra(extra, message, param)) {
				continue;
			}

			this.sessionExtras.delete(extra);
			this.sessionDegradations += 1;

			// Remember an unsupported transcription language for the whole process, so
			// only the first call of a deployment pays for the extra round trip.
			if (
				extra === "transcription_language" &&
				this.transcriptionModel !== null &&
				this.sentTranscriptionLanguage !== null
			) {
				rememberRejectedTranscriptionLanguage(
					this.transcriptionModel,
					this.sentTranscriptionLanguage
				);
			}

			logger.warn(
				{ extra, code, param, message },
				"the Realtime API rejected an optional session field; retrying without it"
			);

			this.sendSessionUpdate();
			return true;
		}

		return false;
	}

	private sendAudioAppend(ulaw: Buffer): void {
		this.send({
			type: "input_audio_buffer.append",
			audio: ulaw.toString("base64"),
		});
	}

	private flushPendingInput(): void {
		if (this.pendingInput.length === 0 || !this.canSendAudio()) {
			return;
		}

		const buffered = Buffer.concat(this.pendingInput);

		this.pendingInput.length = 0;
		this.pendingInputBytes = 0;

		this.sendAudioAppend(buffered);
	}

	// -----------------------------------------
	// Receiving
	// -----------------------------------------

	private handleMessage(data: unknown, socket: WebSocket): void {
		const event = parseRealtimeEvent(data);

		if (event === null) {
			return;
		}

		switch (event.type) {
			case "session.created":
				this.handleSessionCreated(socket);
				return;

			case "session.updated":
				this.markReady(socket);
				return;

			case "error":
				this.handleErrorEvent(event, socket);
				return;

			case "input_audio_buffer.speech_started":
				this.handleSpeechStarted();
				return;

			case "input_audio_buffer.speech_stopped":
			case "input_audio_buffer.committed":
				// The caller has given the floor back, so a response created from here
				// on is an answer to them rather than one that talks over them.
				this.callerSpeaking = false;
				return;

			case "conversation.item.created":
			case "conversation.item.added":
			case "conversation.item.done":
			case "response.output_item.added":
			case "response.output_item.done":
			case "response.content_part.added":
			case "response.content_part.done":
			case "response.function_call_arguments.delta":
			case "rate_limits.updated":
				logger.debug({ type: event.type }, "Realtime event acknowledged");
				return;

			case "conversation.item.input_audio_transcription.delta":
				this.handleCallerTranscriptDelta(event);
				return;

			case "conversation.item.input_audio_transcription.completed":
				this.handleCallerTranscriptDone(event);
				return;

			case "conversation.item.input_audio_transcription.failed":
				logger.warn({ err: event.error }, "caller transcription failed");
				return;

			case "response.created":
				this.handleResponseCreated(event);
				return;

			// The GA names come first; the older aliases are still accepted by
			// some deployments and cost nothing to tolerate.
			case "response.output_audio.delta":
			case "response.audio.delta":
				this.handleOutputAudioDelta(event);
				return;

			case "response.output_audio.done":
			case "response.audio.done":
				logger.debug({ responseId: event.response_id ?? null }, "agent audio finished");
				return;

			case "response.output_audio_transcript.delta":
			case "response.audio_transcript.delta":
				this.handleAgentTranscriptDelta(event);
				return;

			case "response.output_audio_transcript.done":
			case "response.audio_transcript.done":
				this.handleAgentTranscriptDone(event);
				return;

			case "response.function_call_arguments.done":
				this.handleFunctionCall(event).catch((cause: unknown) => {
					logger.error({ err: toError(cause) }, "tool call handling threw");
				});
				return;

			case "response.done":
				this.handleResponseDone(event);
				return;

			default:
				logger.debug({ type: event.type }, "unhandled Realtime event ignored");
				return;
		}
	}

	private handleSessionCreated(socket: WebSocket): void {
		this.sessionCreated = true;
		this.flushPendingInput();

		// session.update was already sent on open; the echo confirms it was
		// applied. If the echo never comes, go ready anyway rather than leaving
		// the caller in silence.
		this.clearReadyTimer();
		this.readyTimer = setTimeout(() => {
			this.readyTimer = null;

			if (!this.sessionReady) {
				logger.warn(
					{ graceMs: this.readyGraceMs },
					"no session.updated echo; treating the session as ready"
				);
				this.markReady(socket);
			}
		}, this.readyGraceMs);
	}

	private markReady(socket: WebSocket): void {
		if (this.sessionReady) {
			return;
		}

		this.sessionCreated = true;
		this.sessionReady = true;
		this.clearReadyTimer();
		this.reconnectAttempts = 0;
		this.flushPendingInput();

		const isReconnect = this.hasBeenReady;
		this.hasBeenReady = true;

		// Resolve the awaited attempt first, then notify: onReady must not reach
		// the orchestrator before its own `await start()` has returned.
		this.settleAttempt(socket, null);

		if (isReconnect) {
			logger.info({ callId: this.context?.callId ?? null }, "Realtime session re-established");
			this.emitTranscript(
				"system",
				"AI bilan aloqa qayta tiklandi.",
				true,
				this.elapsedMs(),
				this.elapsedMs()
			);
			// A new socket is a new conversation, so no turn from the old one is still
			// open and no response id from it can ever be finalised.
			this.agentTranscript.reset();
			this.callerTranscript.reset();
			this.flushPendingSayLines();
			return;
		}

		queueMicrotask(() => {
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

			if (this.autoGreeting && this.context !== null) {
				this.say(this.buildGreetingText(this.context));
			}

			// A line the orchestrator asked for while the session was still coming up
			// (its greeting timer can fire either side of readiness).
			this.flushPendingSayLines();
		});
	}

	/** Speak whatever was held while the session was not ready. */
	private flushPendingSayLines(): void {
		if (this.pendingSayLines.length === 0) {
			return;
		}

		const held = [...this.pendingSayLines];

		this.pendingSayLines.length = 0;

		for (const line of held) {
			this.say(line);
		}
	}

	private handleErrorEvent(event: RealtimeServerEvent, socket: WebSocket): void {
		const code = readNonEmptyString(event.error?.code ?? null);
		const message = event.error?.message ?? "unknown Realtime error";
		const param = readNonEmptyString(event.error?.param ?? null);

		if (isBenignCancelRace(code, message)) {
			logger.debug({ code, message }, "ignoring a benign response.cancel race");
			return;
		}

		if (isActiveResponseConflict(code, message)) {
			// Two response.create events crossed. The scheduler exists to prevent
			// this, but a server-created response (server VAD closing a caller turn)
			// can still collide with one of ours. The turn is not lost: it is queued
			// and sent when the running response finishes.
			logger.debug({ code, message }, "a response was already running; re-queueing the turn");
			this.awaitingResponseCreated = false;
			this.pendingResponseReason = this.pendingResponseReason ?? "retry_after_conflict";
			this.armPendingResponseTimer();
			return;
		}

		if (code !== null && TERMINAL_ERROR_CODES.has(code)) {
			this.terminal = { code, message };

			logger.error(
				{ code, message, model: this.model },
				"the OpenAI account cannot use the Realtime API"
			);

			const wasPending = this.pending?.socket === socket;

			this.settleAttempt(socket, this.buildUnavailableError());
			this.abandonSocket(socket, "provider unavailable");

			if (!wasPending) {
				// Mid-call: the session is gone and retrying is pointless.
				this.emitError(this.buildUnavailableError());
				this.finish("provider_unavailable");
			}

			return;
		}

		// Checked after the terminal codes, so a "model not found" is never mistaken
		// for a complaint about one of the optional fields.
		if (this.degradeSession(code, message, param)) {
			return;
		}

		const error = new Error(
			code === null
				? `OpenAI Realtime error: ${message}`
				: `OpenAI Realtime error (${code}): ${message}`
		);

		logger.warn({ code, message, param }, error.message);
		this.emitError(error);
	}

	/**
	 * Barge-in. The caller started talking, so whatever the agent was saying is
	 * already stale.
	 *
	 * The condition is deliberately NOT "is a response in flight". Transcript and
	 * audio deltas arrive much faster than real time, so the model routinely
	 * finishes generating a turn several seconds before the caller has finished
	 * hearing it - `response.done` has already landed and `activeResponseId` is
	 * null while the agent is still, audibly, talking. Treating that as "nothing to
	 * interrupt" is what makes an agent keep speaking over a caller who has clearly
	 * taken the floor. The playback horizon is what tells the two situations apart.
	 */
	private handleSpeechStarted(): void {
		this.callerUtteranceStartMs = this.elapsedMs();
		this.callerSpeaking = true;

		// Raw speech, reported before anything else decides whether this is a barge-in.
		//
		// The silence-hangup guard used to be fed only by turn-BOUNDARY events -
		// transcripts, tool calls, DTMF - which all arrive after the input buffer is
		// committed. semantic_vad "low" exists precisely to postpone that commit
		// across thinking pauses, so a caller dictating an address in pieces could run
		// the whole silence window down while actively talking and be hung up on
		// mid-sentence. This is the only signal that fires while they are still going.
		this.notifyCallerSpeech();

		const stillAudible = this.playbackHorizonMs > Date.now();

		if (this.activeResponseId === null && !stillAudible) {
			return;
		}

		// The farewell is not interruptible. Cancelling it here would abandon a
		// response the platform is about to wait for, and waitForAgentAudioToFinish
		// would then drain a goodbye that stopped mid-word.
		if (this.bargeInSuppressed) {
			logger.debug(
				{ responseId: this.activeResponseId },
				"ignoring barge-in during the closing line"
			);
			return;
		}

		this.interruptionCount += 1;

		logger.debug(
			{
				responseId: this.activeResponseId,
				stillAudible,
				interruptions: this.interruptionCount,
			},
			"caller interrupted the agent"
		);

		// The orchestrator drops what it has already handed to Asterisk.
		const handlers = this.handlers;

		if (handlers !== null) {
			try {
				handlers.onInterruption();
			} catch (cause) {
				logger.error({ err: cause }, "onInterruption handler threw");
			}
		}

		this.abandonCurrentResponse("interrupted");
		this.armBargeInRecovery();
	}

	/** Tell the orchestrator the caller is talking, whether or not a turn results. */
	private notifyCallerSpeech(): void {
		const handlers = this.handlers;

		if (handlers?.onCallerSpeech === undefined) {
			return;
		}

		try {
			handlers.onCallerSpeech();
		} catch (cause) {
			logger.error({ err: cause }, "onCallerSpeech handler threw");
		}
	}

	/**
	 * Make sure a barge-in cannot leave the line dead.
	 *
	 * Under server_vad, killing the agent's turn was safe: the same acoustic VAD that
	 * fired the interrupt also committed the caller's audio within silence_duration_ms
	 * and every commit produced a reply. semantic_vad splits those in two - the
	 * interrupt is acoustic and instant, but the reply only comes when the classifier
	 * rules the utterance a COMPLETE TURN. A cough, line noise or a backchannel
	 * ("ha", "aha") therefore kills the agent mid-sentence and may never produce a
	 * replacement, and the only backstop left is the silence timer, which ends the
	 * call rather than recovering it.
	 *
	 * So: if nothing has happened a couple of seconds after a barge-in, ask for a
	 * reply. Cheap insurance - it fires only when the alternative is silence.
	 */
	private armBargeInRecovery(): void {
		this.clearBargeInRecovery();

		if (this.turnDetectionMode !== "semantic_vad") {
			return;
		}

		this.bargeInRecoveryTimer = setTimeout(() => {
			this.bargeInRecoveryTimer = null;

			// Something already took over: a new turn is running, the caller is still
			// talking (so a commit is still coming), or the session is gone.
			if (this.stopped || this.activeResponseId !== null || this.callerSpeaking) {
				return;
			}

			logger.info(
				{ afterMs: BARGE_IN_RECOVERY_MS },
				"nothing followed a barge-in; asking the model for a turn so the line is not left dead"
			);
			this.requestResponse("barge-in-recovery");
		}, BARGE_IN_RECOVERY_MS);

		this.bargeInRecoveryTimer.unref?.();
	}

	private clearBargeInRecovery(): void {
		if (this.bargeInRecoveryTimer !== null) {
			clearTimeout(this.bargeInRecoveryTimer);
			this.bargeInRecoveryTimer = null;
		}
	}

	/**
	 * Stop cancelling the agent's turn on caller noise.
	 *
	 * Used for the closing line, which the platform speaks and then waits to drain:
	 * a stray "rahmat" over the goodbye must not abandon the very response being
	 * waited for. semantic_vad makes this more likely, not less - its acoustic front
	 * end runs at the API's default threshold, below the 0.55 that was tuned to clear
	 * a telephony noise floor.
	 */
	suppressBargeIn(): void {
		this.bargeInSuppressed = true;
		this.clearBargeInRecovery();
	}

	/**
	 * Stop the agent talking, now.
	 *
	 * Four things have to happen together, and leaving any one of them out lets
	 * the agent finish its sentence over the caller:
	 *   - drop the decoded audio we have not handed over yet;
	 *   - stop the clock that says audio is still playing;
	 *   - mark the response id so deltas already on the wire are discarded on
	 *     arrival rather than queued behind the cancel;
	 *   - finalise the transcript turn, so the part that was actually said is
	 *     stored once and the next turn starts clean.
	 */
	private abandonCurrentResponse(reason: "interrupted" | "cancelled"): void {
		const responseId = this.activeResponseId;
		// The turn being abandoned is not always the one the server still calls
		// active: when generation finished ahead of playback, `response.done` has
		// already cleared activeResponseId while that response's audio is what the
		// caller is hearing. Its id is the one whose audio must stop counting.
		const audibleResponseId = responseId ?? this.lastAudioResponseId;

		logger.debug(
			{ reason, responseId, audibleResponseId, droppedChunks: this.outboundQueue.length },
			"abandoning the agent's turn"
		);

		this.outboundQueue.length = 0;
		this.playbackHorizonMs = 0;

		// A holding line for a tool call the caller has just talked over would
		// arrive as an answer to something they did not ask.
		this.clearPendingTool();

		// Whatever we were about to ask the model for is stale too. After a barge-in
		// the caller's own audio drives the next response through server VAD, and a
		// queued create would race it.
		this.pendingResponseReason = null;
		this.clearPendingResponseTimer();

		this.finaliseAgentTurn();

		if (audibleResponseId !== null) {
			this.markResponseCancelled(audibleResponseId);
		}

		if (responseId === null) {
			return;
		}

		this.activeResponseId = null;
		this.agentResponseStartMs = null;
		this.send({ type: "response.cancel", response_id: responseId });
	}

	/** Remember that a response's audio must not be played, newest ids kept. */
	private markResponseCancelled(responseId: string): void {
		this.cancelledResponses.add(responseId);

		while (this.cancelledResponses.size > MAX_TRACKED_CANCELLED_RESPONSES) {
			const oldest = this.cancelledResponses.values().next();

			if (oldest.done === true) {
				break;
			}

			this.cancelledResponses.delete(oldest.value);
		}
	}

	private handleResponseCreated(event: RealtimeServerEvent): void {
		this.activeResponseId = readNonEmptyString(event.response?.id ?? null);
		this.agentResponseStartMs = this.elapsedMs();
		this.awaitingResponseCreated = false;
		this.responseProducedAudio = false;
		this.clearPendingResponseTimer();

		if (this.callerSpeaking) {
			// A response we asked for just before the caller took the floor. Letting it
			// run would put the agent's voice on top of somebody who is mid-sentence,
			// and nothing is lost by dropping it: when the caller's turn is committed
			// the server starts a fresh response that has their words in it.
			logger.debug(
				{ responseId: this.activeResponseId },
				"a response was created while the caller was speaking; cancelling it"
			);
			this.abandonCurrentResponse("cancelled");
		}
	}

	private handleOutputAudioDelta(event: RealtimeServerEvent): void {
		const delta = readNonEmptyString(event.delta ?? null);

		if (delta === null) {
			return;
		}

		const responseId = readNonEmptyString(event.response_id ?? null);

		// Audio OpenAI had already put on the wire when we cancelled: playing it
		// would talk over the caller who just interrupted.
		if (responseId !== null && this.cancelledResponses.has(responseId)) {
			return;
		}

		const ulaw = Buffer.from(delta, "base64");

		if (ulaw.length === 0) {
			return;
		}

		this.outputUlawBytes += ulaw.length;
		this.responseProducedAudio = true;
		this.lastAudioResponseId = responseId ?? this.lastAudioResponseId;

		// Push the horizon out by the real duration of this chunk. Starting from
		// max(horizon, now) means a gap in generation does not accumulate credit:
		// once playback has caught up, the next chunk starts from now.
		const now = Date.now();
		const chunkMs = ulaw.length / ULAW_BYTES_PER_MS;

		this.playbackHorizonMs = Math.max(this.playbackHorizonMs, now) + chunkMs;

		this.outboundQueue.push(muLawDecode(ulaw));
		this.deliverOutboundAudio();
	}

	/**
	 * Hand queued audio to the orchestrator.
	 *
	 * The queue exists so a barge-in can throw away audio that has been decoded
	 * but not yet delivered, and the re-entrancy guard keeps a handler that
	 * synchronously pushes more work from recursing into this drain.
	 */
	private deliverOutboundAudio(): void {
		if (this.deliveringAudio) {
			return;
		}

		const handlers = this.handlers;

		if (handlers === null) {
			this.outboundQueue.length = 0;
			return;
		}

		this.deliveringAudio = true;

		try {
			while (this.outboundQueue.length > 0) {
				const chunk = this.outboundQueue.shift();

				if (chunk === undefined) {
					break;
				}

				try {
					handlers.onAudio(chunk);
				} catch (cause) {
					logger.error({ err: cause }, "onAudio handler threw");
				}
			}
		} finally {
			this.deliveringAudio = false;
		}
	}

	/**
	 * A fragment of what the caller is saying.
	 *
	 * whisper-1 (the configured default) sends none of these - it only ever sends
	 * `.completed` - but the gpt-4o transcribers do, and a long utterance streams
	 * for well over the consumer's interim write interval, so the same duplicate
	 * row the agent side suffered from would appear here the day the transcription
	 * model is changed. Both roles go through the same guard.
	 */
	private handleCallerTranscriptDelta(event: RealtimeServerEvent): void {
		const delta = readNonEmptyString(event.delta ?? null);

		if (delta === null) {
			return;
		}

		const itemId = readNonEmptyString(event.item_id ?? null);
		const fragment = this.callerTranscript.pushDelta(itemId, delta, Date.now());

		if (fragment !== null) {
			this.emitTranscript("caller", fragment, false, this.callerUtteranceStartMs);
		}
	}

	private handleCallerTranscriptDone(event: RealtimeServerEvent): void {
		const itemId = readNonEmptyString(event.item_id ?? null);
		const final = this.callerTranscript.finalise(itemId, event.transcript ?? null);

		if (final !== null && !this.isEchoOfTranscriptionPrompt(final)) {
			this.emitTranscript("caller", final, true, this.callerUtteranceStartMs, this.elapsedMs());
		}

		this.callerUtteranceStartMs = null;
		this.reportTranscriptionUsage(event);
	}

	/**
	 * What the separately-billed transcription model charged for this utterance.
	 *
	 * gpt-4o-transcribe is not part of the Realtime session's own usage, so
	 * without this the transcription of every caller turn is spent and never
	 * counted anywhere.
	 */
	private reportTranscriptionUsage(event: RealtimeServerEvent): void {
		const usage = event.usage;
		const handlers = this.handlers;

		if (usage === undefined || handlers?.onTranscriptionUsage === undefined) {
			return;
		}

		try {
			handlers.onTranscriptionUsage({
				audioTokens: readNumber(usage.input_token_details?.audio_tokens),
				textTokens: readNumber(usage.input_token_details?.text_tokens),
				seconds: readNumber(usage.seconds),
				model: this.transcriptionModel ?? undefined,
			});
		} catch (cause) {
			logger.error({ err: cause }, "onTranscriptionUsage handler threw");
		}
	}

	/**
	 * Did the transcriber hand back our own decoding hint instead of speech?
	 *
	 * A transcriber given a prompt and near-silence sometimes returns the prompt -
	 * observed on a mostly-silent recording, which came back as "context: ###"
	 * followed by the hint verbatim. Letting that through would put the platform's
	 * internal steering text into the CRM as something the caller said, and from
	 * there into the post-call summary.
	 */
	private isEchoOfTranscriptionPrompt(text: string): boolean {
		const trimmed = text.trim();

		if (trimmed.length === 0) {
			return false;
		}

		if (/^(context\s*:|#{3})/i.test(trimmed)) {
			return true;
		}

		const prompt = this.sentTranscriptionPrompt;

		if (prompt === null) {
			return false;
		}

		// Compare on a distinctive opening slice rather than the whole string: the
		// echo is often truncated or lightly reworded.
		const probe = prompt.slice(0, 40).toLowerCase();

		return probe.length > 0 && trimmed.toLowerCase().includes(probe);
	}

	private handleAgentTranscriptDelta(event: RealtimeServerEvent): void {
		const delta = readNonEmptyString(event.delta ?? null);

		if (delta === null) {
			return;
		}

		const responseId = readNonEmptyString(event.response_id ?? null);

		if (responseId !== null && this.cancelledResponses.has(responseId)) {
			// Cancelled mid-sentence: the turn was finalised with what had actually
			// been said, and these late fragments would re-open it.
			return;
		}

		const fragment = this.agentTranscript.pushDelta(responseId, delta, Date.now());

		if (fragment !== null) {
			this.emitTranscript("agent", fragment, false, this.agentResponseStartMs);
		}
	}

	private handleAgentTranscriptDone(event: RealtimeServerEvent): void {
		const responseId = readNonEmptyString(event.response_id ?? null);
		const final = this.agentTranscript.finalise(responseId, event.transcript ?? null);

		if (final !== null) {
			this.emitTranscript("agent", final, true, this.agentResponseStartMs, this.elapsedMs());
		}
	}

	/**
	 * Close the agent's open turn, emitting the one final line it is entitled to.
	 *
	 * The text is what the model had produced when the turn was cut, not a guess at
	 * how much of it the caller actually heard: the audio was dropped somewhere
	 * between here and the handset, and there is no honest way to place that
	 * boundary inside a sentence.
	 */
	private finaliseAgentTurn(): void {
		const final = this.agentTranscript.abandon();

		if (final !== null) {
			this.emitTranscript("agent", final, true, this.agentResponseStartMs, this.elapsedMs());
		}
	}

	/** Flush both roles' open turns, used when the session ends mid-sentence. */
	private flushOpenTranscriptTurns(): void {
		this.finaliseAgentTurn();

		const caller = this.callerTranscript.abandon();

		if (caller !== null) {
			this.emitTranscript("caller", caller, true, this.callerUtteranceStartMs, this.elapsedMs());
		}
	}

	private async handleFunctionCall(event: RealtimeServerEvent): Promise<void> {
		const name = readNonEmptyString(event.name ?? null);
		const toolCallId = readNonEmptyString(event.call_id ?? null);

		if (name === null || toolCallId === null) {
			logger.warn(
				{ name, toolCallId },
				"a function call arrived without a name or a call id, ignoring it"
			);
			return;
		}

		const parsed = parseToolArguments(event.arguments);

		if (!parsed.ok) {
			logger.warn({ name, detail: parsed.error }, "unparseable tool arguments");
			// Answer the model instead of going silent: it can retry the call.
			this.sendToolResult(toolCallId, { ok: false, error: parsed.error });
			return;
		}

		const args = parsed.args;
		const handlers = this.handlers;

		if (handlers === null) {
			return;
		}

		logger.info({ name, toolCallId, callId: this.context?.callId ?? null }, "AI tool call");

		// Starts the clock on the holding line. sendToolResult() stops it, so a tool
		// that answers quickly never causes an extra spoken line.
		this.beginToolCall(name);

		try {
			const result = await handlers.onToolCall({ name, toolCallId, args });

			// `undefined` means the orchestrator will answer later itself (for
			// example after a transfer has actually connected).
			if (result === undefined) {
				// Nothing will arrive to stop the holding line, and the orchestrator is
				// mid-transfer: the caller must not hear "bir daqiqa" now.
				this.clearPendingTool();
			} else {
				this.sendToolResult(toolCallId, result);
			}
		} catch (cause) {
			const error = toError(cause);

			logger.error({ err: error, name, toolCallId }, "tool handler failed");
			this.sendToolResult(toolCallId, { ok: false, error: error.message });
		}
	}

	private handleResponseDone(event: RealtimeServerEvent): void {
		const responseId = readNonEmptyString(event.response?.id ?? null);
		const status = event.response?.status ?? "";

		if (responseId !== null && responseId === this.activeResponseId) {
			this.activeResponseId = null;
		}

		// The turn suppression was protecting is over, so the caller gets the floor
		// back. Without this the flag is a one-way latch: announceBeforeAction sets it
		// before a transfer, and a transfer that reaches nobody hands the caller BACK
		// to the agent - with barge-in dead for the rest of the call, on a phone line.
		// The Gemini provider clears it at turnComplete for the same reason.
		this.bargeInSuppressed = false;

		if (status === "failed") {
			logger.warn(
				{ responseId, details: event.response?.status_details },
				"Realtime response failed"
			);
		}

		// "incomplete" is what the caller hears as a sentence that stops mid-word,
		// and max_output_tokens is the most likely reason for it. Silently swallowing
		// it would turn a caller-visible defect into an invisible one, and hide the
		// signal that says the cap is set too low for this business.
		if (status === "incomplete") {
			logger.warn(
				{
					responseId,
					maxOutputTokens: this.maxOutputTokens,
					details: event.response?.status_details,
				},
				"Realtime response was cut short - raise OPENAI_REALTIME_MAX_OUTPUT_TOKENS if this recurs"
			);
		}

		// The model is not speaking any more, so anything that was waiting for a
		// clear channel can go now: a queued response.create, or the holding line
		// for a tool that is still running.
		this.flushPendingResponse();
		this.maybeSpeakToolAcknowledgement();

		const usage = event.response?.usage;

		if (usage === undefined) {
			return;
		}

		const handlers = this.handlers;

		if (handlers === null) {
			return;
		}

		try {
			handlers.onUsage({
				promptTokens: readNumber(usage.input_tokens),
				completionTokens: readNumber(usage.output_tokens),
				cachedTokens: readNumber(usage.input_token_details?.cached_tokens),
				cachedAudioTokens: readNumber(
					usage.input_token_details?.cached_tokens_details?.audio_tokens
				),
				cachedTextTokens: readNumber(usage.input_token_details?.cached_tokens_details?.text_tokens),
				inputAudioTokens: readNumber(usage.input_token_details?.audio_tokens),
				inputTextTokens: readNumber(usage.input_token_details?.text_tokens),
				outputAudioTokens: readNumber(usage.output_token_details?.audio_tokens),
				outputTextTokens: readNumber(usage.output_token_details?.text_tokens),
			});
		} catch (cause) {
			logger.error({ err: cause }, "onUsage handler threw");
		}
	}

	// -----------------------------------------
	// Response scheduling
	// -----------------------------------------

	/**
	 * Ask the model to produce a turn, waiting for a clear channel if necessary.
	 *
	 * The API permits one response at a time. Two `response.create` events with a
	 * response already running earns an error and one lost turn, and a lost turn
	 * after a tool call is heard as the agent simply never answering - the single
	 * most damaging failure mode this provider has, because the caller has just
	 * given it their address and gets silence back.
	 */
	private requestResponse(reason: string): void {
		if (this.stopped) {
			return;
		}

		if (this.activeResponseId !== null || this.awaitingResponseCreated) {
			// Last request wins: an older queued turn is stale by definition, since
			// whatever prompted it is now behind the newer item in the conversation.
			this.pendingResponseReason = reason;
			this.armPendingResponseTimer();

			logger.debug({ reason }, "a response is already running; queueing the next one");
			return;
		}

		this.awaitingResponseCreated = true;
		this.armPendingResponseTimer();
		this.send({ type: "response.create" });
	}

	/**
	 * Safety net for a `response.created` or `response.done` that never arrives.
	 *
	 * Without it a dropped event would leave `awaitingResponseCreated` set for the
	 * rest of the call and every later turn would be queued behind it forever.
	 */
	private armPendingResponseTimer(): void {
		this.clearPendingResponseTimer();

		this.pendingResponseTimer = setTimeout(() => {
			this.pendingResponseTimer = null;

			if (this.stopped) {
				return;
			}

			if (this.awaitingResponseCreated) {
				logger.warn("no response.created arrived; clearing the response gate");
				this.awaitingResponseCreated = false;
			}

			this.flushPendingResponse();
		}, PENDING_RESPONSE_TIMEOUT_MS);
	}

	private clearPendingResponseTimer(): void {
		if (this.pendingResponseTimer !== null) {
			clearTimeout(this.pendingResponseTimer);
			this.pendingResponseTimer = null;
		}
	}

	/** Send a queued response.create, if the channel is now clear. */
	private flushPendingResponse(): void {
		const reason = this.pendingResponseReason;

		if (reason === null || this.stopped) {
			return;
		}

		if (this.activeResponseId !== null || this.awaitingResponseCreated) {
			return;
		}

		this.pendingResponseReason = null;
		this.awaitingResponseCreated = true;
		this.armPendingResponseTimer();

		logger.debug({ reason }, "sending the queued response.create");
		this.send({ type: "response.create" });
	}

	// -----------------------------------------
	// Tool calls
	// -----------------------------------------

	/** The language the platform's own holding lines are spoken in. */
	private spokenLanguage(): string {
		const language = this.context?.language.trim() ?? "";

		return language.length > 0 ? language : this.agentProfile.language;
	}

	/**
	 * Start covering the silence a tool call opens up.
	 *
	 * Only a tool call the model made SILENTLY needs covering. When it followed the
	 * instructions and said "bir daqiqa, yozib olaman" first, that turn produced
	 * audio and a second holding line would be one more thing for the caller to sit
	 * through.
	 */
	private beginToolCall(name: string): void {
		if (this.toolAcknowledgementDelayMs <= 0 || this.responseProducedAudio) {
			return;
		}

		if (buildToolAcknowledgement(this.spokenLanguage(), name) === null) {
			// transfer_to_human and end_call: the model's own line is the last thing
			// the caller should hear before the line changes.
			return;
		}

		this.pendingTool = { name, requestedAtMs: Date.now(), acknowledged: false };

		if (this.toolFillerTimer !== null) {
			clearTimeout(this.toolFillerTimer);
		}

		this.toolFillerTimer = setTimeout(() => {
			this.toolFillerTimer = null;
			this.maybeSpeakToolAcknowledgement();
		}, this.toolAcknowledgementDelayMs);
	}

	/**
	 * Speak the holding line, if it is still both needed and possible.
	 *
	 * Called from the delay timer and again from `response.done`, because the
	 * silent tool-call turn is usually still open when the timer fires and the line
	 * cannot be sent until it closes.
	 */
	private maybeSpeakToolAcknowledgement(): void {
		const pending = this.pendingTool;

		if (pending === null || pending.acknowledged || this.stopped || !this.sessionReady) {
			return;
		}

		if (Date.now() - pending.requestedAtMs < this.toolAcknowledgementDelayMs) {
			return;
		}

		// Waiting for a clear channel rather than queueing: by the time a running
		// response finishes, the tool has usually answered and the line is moot.
		if (this.activeResponseId !== null || this.awaitingResponseCreated) {
			return;
		}

		const line = buildToolAcknowledgement(this.spokenLanguage(), pending.name);

		if (line === null) {
			return;
		}

		pending.acknowledged = true;

		logger.debug({ tool: pending.name }, "speaking a holding line while a tool runs");
		this.say(line);
	}

	/** The tool has answered (or the turn was abandoned): no line is needed. */
	private clearPendingTool(): void {
		this.pendingTool = null;

		if (this.toolFillerTimer !== null) {
			clearTimeout(this.toolFillerTimer);
			this.toolFillerTimer = null;
		}
	}

	// -----------------------------------------
	// Handler plumbing
	// -----------------------------------------

	private elapsedMs(): number {
		return this.startedAtMs === 0 ? 0 : Date.now() - this.startedAtMs;
	}

	private emitTranscript(
		role: TranscriptRole,
		content: string | undefined,
		isFinal: boolean,
		startMs: number | null,
		endMs?: number
	): void {
		const handlers = this.handlers;

		if (handlers === null || typeof content !== "string" || content.length === 0) {
			return;
		}

		try {
			handlers.onTranscript({
				role,
				content,
				isFinal,
				startMs: startMs ?? undefined,
				endMs,
			});
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
 * Build a provider for one call. Instances are single-use: `calls.id` is the
 * unit of work, and a session that has ended cannot be restarted.
 */
export function createOpenAiRealtimeProvider(
	options: OpenAiRealtimeProviderOptions = {}
): VoiceProvider {
	return new OpenAiRealtimeProvider(options);
}

// ===========================================
// Health probe
// ===========================================

export interface RealtimeProbeOptions {
	apiKey?: string;
	model?: string;
	baseUrl?: string;
	/** How long to wait for `session.created`. Default 8 s. */
	timeoutMs?: number;
}

export interface RealtimeProbeResult {
	ok: boolean;
	model: string;
	/** OpenAI's error code when the probe failed, else null. */
	code: string | null;
	detail: string;
}

/**
 * Decide whether a probe can conclude from this event. `session.created` is the
 * only success signal; `error` is the interesting failure, because its code is
 * what tells an operator whether the account lacks the model or the quota.
 */
function readProbeResult(event: RealtimeServerEvent, model: string): RealtimeProbeResult | null {
	if (event.type === "session.created") {
		return {
			ok: true,
			model,
			code: null,
			detail: `a Realtime session was negotiated with model ${model}`,
		};
	}

	if (event.type === "error") {
		return {
			ok: false,
			model,
			code: readNonEmptyString(event.error?.code ?? null) ?? "error",
			detail: event.error?.message ?? "the Realtime API returned an error",
		};
	}

	return null;
}

/**
 * Open a Realtime session, wait for `session.created`, close it again.
 *
 * This is the only honest way to answer "can this account use Realtime?": the
 * REST model list and the Realtime entitlement are different things, and a key
 * that lists a model can still be refused at session creation. Used by
 * /api/ai-assistant/status through probeProviderHealth().
 */
export function probeOpenAiRealtime(
	options: RealtimeProbeOptions = {}
): Promise<RealtimeProbeResult> {
	const apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();
	const model = options.model ?? process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_MODEL;
	const baseUrl = options.baseUrl ?? DEFAULT_REALTIME_URL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

	if (apiKey.length === 0) {
		return Promise.resolve({
			ok: false,
			model,
			code: "missing_api_key",
			detail: "OPENAI_API_KEY is not set",
		});
	}

	return new Promise<RealtimeProbeResult>((resolve) => {
		let socket: WebSocket;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const settle = (result: RealtimeProbeResult): void => {
			if (settled) {
				return;
			}

			settled = true;

			if (timer !== null) {
				clearTimeout(timer);
			}

			try {
				socket.onopen = null;
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				socket.close(1000, "probe complete");
			} catch (cause) {
				logger.debug({ err: cause }, "closing the probe socket threw, ignoring");
			}

			resolve(result);
		};

		try {
			socket = new BunWebSocket(`${baseUrl}?model=${encodeURIComponent(model)}`, {
				headers: { Authorization: `Bearer ${apiKey}` },
			});
		} catch (cause) {
			resolve({
				ok: false,
				model,
				code: "connect_failed",
				detail: `could not open a Realtime socket: ${toError(cause).message}`,
			});
			return;
		}

		timer = setTimeout(() => {
			settle({
				ok: false,
				model,
				code: "timeout",
				detail: `no session.created within ${timeoutMs} ms`,
			});
		}, timeoutMs);

		socket.onmessage = (event: MessageEvent) => {
			const message = parseRealtimeEvent(event.data);

			if (message === null) {
				return;
			}

			const result = readProbeResult(message, model);

			if (result !== null) {
				settle(result);
			}
		};

		socket.onclose = (event: CloseEvent) => {
			const reason = event.reason.length > 0 ? `: ${event.reason}` : "";

			settle({
				ok: false,
				model,
				code: "closed",
				detail: `the Realtime socket closed before a session was created (code ${event.code}${reason})`,
			});
		};

		socket.onerror = () => {
			logger.debug({ model }, "the Realtime probe socket reported an error");
		};
	});
}
