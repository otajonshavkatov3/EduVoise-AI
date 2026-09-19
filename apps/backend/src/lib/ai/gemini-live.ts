/**
 * Google Gemini Live - a second speech-to-speech voice provider.
 *
 * Same contract as the OpenAI Realtime provider, chosen by provider-factory, so
 * a deployment switches between them with AI_VOICE_PROVIDER and nothing
 * downstream changes: the orchestrator, the AudioSocket pacing, barge-in, the
 * CRM writes and the tools are all shared.
 *
 * WHY IT EXISTS: Uzbek. Measured on this account against real caller audio, the
 * Live model answers in fluent, idiomatic Uzbek with the spoken forms a person
 * actually uses ("zo'r ish bo'pti", "bemalol"), and its prosody comes from the
 * model itself rather than from a text-to-speech pass bolted on afterwards.
 *
 * THE TWO FACTS THAT SHAPED THIS FILE, both established against the live API:
 *
 *   1. It accepts 8 kHz input. Asterisk's own frames go straight up with no
 *      resampling - verified by feeding it recorded 8 kHz Uzbek speech, which it
 *      transcribed and answered. (16 kHz is the documented rate; 8 kHz simply
 *      works, and avoiding a resampler removes latency and a whole class of bug.)
 *   2. It returns 24 kHz PCM, which `downsample24kTo8k` already handles - the
 *      same filter the OpenAI leg uses, so both providers sound alike on the wire.
 *
 * Time to first audio, measured across eight voices: 734-879 ms.
 *
 * HOW IT SOUNDS IS CONFIGURATION, NOT CODE. The voice, the dialect, the sampling
 * knobs and the turn-taking timings all come from system_settings (see
 * TUNING_KEYS), are read once per session before the socket opens, and take
 * effect on the next call with no restart. Nothing here is required to exist: a
 * key the registry has not got falls back to a documented default, so this file
 * works against an older registry and against none at all.
 *
 * DELIBERATELY SIMPLER THAN THE OPENAI PROVIDER. That one carries a lot of scar
 * tissue - response serialisation, tool holding lines, session degradation,
 * playback-horizon tracking. None of it is copied here on spec. What IS here is
 * everything the VoiceProvider contract requires and everything a live call has
 * been shown to need; the rest earns its place when a real call proves it does.
 */
import { Buffer } from "node:buffer";

import pino from "pino";
import pretty from "pino-pretty";
import type { ActiveAgentProfile, KnowledgeHit } from "@/lib/ai-agent";
import type { SettingPrimitive } from "@/lib/settings";
import { listSettings } from "@/lib/settings";
import type {
	TranscriptRole,
	VoiceProvider,
	VoiceProviderHandlers,
	VoiceProviderStats,
	VoiceSessionContext,
} from "@/lib/telephony/contracts";
import { VoiceProviderUnavailableError } from "@/lib/telephony/contracts";
import type { TenantId } from "@/lib/tenancy";
import type { AgentVoiceChain } from "./codec";
import {
	createAgentVoiceChain,
	OUTPUT_GAIN_MAX_DB,
	PRESENCE_CENTRE_HZ,
	PRESENCE_MAX_DB,
} from "./codec";
import type { AgentDialectId } from "./prompts";
import {
	buildGreeting,
	buildSystemInstructions,
	DEFAULT_AGENT_DIALECT,
	resolveAgentDialect,
	unconfiguredAgentProfile,
} from "./prompts";
import type { RealtimeToolDefinition } from "./tools";
import { buildToolDefinitions, toolsForCall, validateToolArguments } from "./tools";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{ level: process.env.LOG_LEVEL ?? "info", base: { module: "ai:gemini-live" } },
	isProduction ? undefined : pretty({ colorize: true, translateTime: "HH:MM:ss.l" })
);

export const GEMINI_LIVE_PROVIDER_NAME = "gemini-live";

const WS_BASE =
	"wss://generativelanguage.googleapis.com/ws/" +
	"google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * The live model, not the native-audio one.
 *
 * Both were measured on the same Uzbek turn: this answered in 831 ms, while
 * gemini-2.5-flash-native-audio-latest took 5173 ms AND leaked its own reasoning
 * ("Assessing Initial Request") into the spoken reply.
 */
const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

/** Measured usable on Uzbek calls, and the value .env ships with. */
const DEFAULT_VOICE = "Callirrhoe";

export interface GeminiVoiceOption {
	/** Exactly as the API spells it - it goes on the wire unchanged. */
	name: string;
	/** The character Google publishes for the voice, in its own English wording. */
	character: string;
	/** The same thing in Uzbek, because the dropdown is read by the business owner. */
	description: string;
	/**
	 * How well this voice survives a telephone line, in dB. Measured here, on
	 * this account - see PHONE_CLARITY_DB for what the number is and how. Null
	 * when nobody has measured it, which is honest rather than helpful: an
	 * invented figure next to a voice name would be read as fact.
	 */
	phoneClarityDb: number | null;
	/** The same thing as the one Uzbek phrase a business owner can act on. */
	phoneClarity: string;
}

/**
 * Consonant energy against vowel energy, per voice, in dB.
 *
 * WHAT IT IS: 10*log10(energy in 1200-3400 Hz / energy in 300-1200 Hz) over a
 * spoken Uzbek sentence. A telephone carries 300-3400 Hz and nothing else, and
 * the consonants that let a listener tell "besh" from "bes" live in the top half
 * of it. A voice at -5 dB arrives with its consonants nearly as strong as its
 * vowels; one at -17 dB arrives as a warm mumble. The measured spread here is
 * 12 dB, which is more than twice what the presence filter in codec.ts can add -
 * so which voice a business picks matters more to how clear its line sounds than
 * anything in the DSP does. That is the point of publishing the column.
 *
 * HOW IT WAS MEASURED, and how far to trust it. Each voice was rendered through
 * this deployment's own POST /api/ai-assistant/voice-preview at 24 kHz, by
 * voice-brightness.ts. Two sentences were completed before the day's TTS quota
 * ran out: all thirty voices on one, twenty-three of them on a second. A
 * sibilant-heavy sentence measures brighter for EVERY voice, so the second pass
 * was shifted onto the first's scale by the median paired difference (2.8 dB)
 * before the two were averaged; a voice measured once is therefore on the same
 * scale as the rest, only noisier.
 *
 * The numbers that matter for reading this table:
 *
 *   between-voice spread   2.9 dB sd   (the signal)
 *   one render             2.0 dB sd   (the noise, one voice in 53 far worse)
 *   two renders averaged   1.4 dB se
 *   rank correlation between the two passes   0.58, or 0.39 with Erinome kept
 *
 * So the figures are rounded to WHOLE dB - a tenth would be invented precision -
 * and only differences of about 4 dB and up mean anything. Iapetus against
 * Vindemiatrix is a real 12 dB; Kore against Orus is not a difference at all.
 * Erinome is the one voice the two passes flatly disagreed about (-20.6 and
 * -1.2 on the same scale); its -12 is the average of contradictory evidence and
 * should be re-measured before anyone relies on it.
 *
 * WHY IT IS A STORED TABLE. Thirty voices is thirty TTS requests against a quota
 * of ten a minute, so a page that measured on load would take three minutes and
 * spend the quota the preview button needs. The figures change only when Google
 * changes the voices, which is when this block should be regenerated - not once
 * per page view.
 */
const PHONE_CLARITY_DB: Record<string, number | null> = {
	Achernar: -14,
	Achird: -8,
	Algenib: -12,
	Algieba: -9,
	Alnilam: -8,
	Aoede: -14,
	Autonoe: -13,
	Callirrhoe: -13,
	Charon: -11,
	Despina: -14,
	Enceladus: -10,
	Erinome: -12,
	Fenrir: -7,
	Gacrux: -13,
	Iapetus: -5,
	Kore: -10,
	Laomedeia: -12,
	Leda: -14,
	Orus: -10,
	Puck: -6,
	Pulcherrima: -13,
	Rasalgethi: -9,
	Sadachbia: -10,
	// Rendered once each, and one render carries about 3 dB of noise - enough to
	// move a voice across two of the three bands below. A single figure here would
	// have sorted these against twice-measured voices as though it meant the same
	// thing; null makes them read "O'lchanmagan", which is what they are. Give each
	// a second and third render and the numbers belong back in the list above.
	Sadaltager: null,
	Schedar: null,
	Sulafat: null,
	Umbriel: null,
	Vindemiatrix: null,
	Zephyr: null,
	Zubenelgenubi: null,
};

/**
 * The measured dB turned into the one phrase a business owner can act on.
 *
 * THREE bands, not five, and they are wide on purpose. A single render carries
 * about 3 dB of noise and two averaged about 2 dB, so a band narrower than about
 * 4 dB would flip on that alone and tell somebody their voice had changed when
 * nothing had. The cuts fall at -8 and -12.
 *
 * An independent run on this same account, eight voices, agreed on the extremes
 * and disagreed in the middle: Iapetus -5.6 against -5 and Zephyr -15.1 against
 * -14, but Kore -6.1 against -10 and Erinome -6.7 against -12. Treat a difference
 * under about 4 dB as no difference at all; the table separates "clear" from
 * "muffled", not one voice from the next.
 */
export function phoneClarityLabel(clarityDb: number | null): string {
	if (clarityDb === null) {
		return "O'lchanmagan";
	}
	if (clarityDb >= -8) {
		return "Telefonda tiniq";
	}
	if (clarityDb >= -12) {
		return "Telefonda o'rtacha";
	}
	return "Telefonda bo'g'iq";
}

/**
 * Every prebuilt voice this model accepts, with the character Google publishes
 * for it.
 *
 * ALL THIRTY were verified individually against gemini-3.1-flash-live-preview on
 * this account: each one opened a session and spoke. The list used to hold
 * fifteen, and resolveVoice() silently substituted the default for the rest - so
 * half the legal voices were unreachable, and a dashboard that offered them was
 * lying. Widening it is the whole point: "choose the voice freely" is not a
 * feature you can implement behind an allowlist half the size of reality.
 *
 * The character is data, not decoration: thirty Greek and Arabic star names are
 * unchoosable without it, and it is Google's own word for the voice rather than
 * an impression formed here.
 *
 * NOT recorded: gender. Google does not publish it, nobody has measured it on
 * this account, and a guess printed next to a voice name would be read as fact.
 *
 * A name that is not on this list still falls back to the default rather than
 * going up the socket, because a wrong voice name is not a cosmetic error:
 *
 *   1007 No matching speaker voice found for name: cedar
 *
 * closes the session, and a closed session is a dropped call. OpenAI voice names
 * ("cedar", "alloy") are the ones that reach here in practice, from a profile
 * configured before the deployment switched provider.
 *
 * The measured phone clarity is joined on below rather than typed into each row,
 * so the one block a re-measurement has to replace is PHONE_CLARITY_DB.
 */
const VOICE_CHARACTERS: readonly Omit<GeminiVoiceOption, "phoneClarityDb" | "phoneClarity">[] = [
	{ name: "Achernar", character: "Soft", description: "Yumshoq, past ovozli" },
	{ name: "Achird", character: "Friendly", description: "Do'stona, iliq" },
	{ name: "Algenib", character: "Gravelly", description: "Bo'g'iq, xirillagan" },
	{ name: "Algieba", character: "Smooth", description: "Silliq, tekis" },
	{ name: "Alnilam", character: "Firm", description: "Qat'iy, ishonchli" },
	{ name: "Aoede", character: "Breezy", description: "Erkin, yengil" },
	{ name: "Autonoe", character: "Bright", description: "Yorqin, tetik" },
	{ name: "Callirrhoe", character: "Easy-going", description: "Xotirjam, bosiq" },
	{ name: "Charon", character: "Informative", description: "Tushuntiruvchi, ma'lumot beruvchi" },
	{ name: "Despina", character: "Smooth", description: "Silliq, yoqimli" },
	{ name: "Enceladus", character: "Breathy", description: "Nafas aralash, mayin" },
	{ name: "Erinome", character: "Clear", description: "Tiniq, aniq" },
	{ name: "Fenrir", character: "Excitable", description: "Jo'shqin, hayajonli" },
	{ name: "Gacrux", character: "Mature", description: "Yetuk, vazmin" },
	{ name: "Iapetus", character: "Clear", description: "Tiniq, ravon" },
	{ name: "Kore", character: "Firm", description: "Qat'iy, dadil" },
	{ name: "Laomedeia", character: "Upbeat", description: "Quvnoq, ko'tarinki" },
	{ name: "Leda", character: "Youthful", description: "Yoshlarcha, yengil" },
	{ name: "Orus", character: "Firm", description: "Qat'iy, jiddiy" },
	{ name: "Pulcherrima", character: "Forward", description: "Dadil, tashabbuskor" },
	{ name: "Puck", character: "Upbeat", description: "Quvnoq, shaddod" },
	{ name: "Rasalgethi", character: "Informative", description: "Ma'lumot beruvchi, bosiq" },
	{ name: "Sadachbia", character: "Lively", description: "Jonli, harakatchan" },
	{ name: "Sadaltager", character: "Knowledgeable", description: "Bilimdon, ishonchli" },
	{ name: "Schedar", character: "Even", description: "Bir tekis, xotirjam" },
	{ name: "Sulafat", character: "Warm", description: "Iliq, mehribon" },
	{ name: "Umbriel", character: "Easy-going", description: "Xotirjam, kelishuvchan" },
	{ name: "Vindemiatrix", character: "Gentle", description: "Muloyim, ohista" },
	{ name: "Zephyr", character: "Bright", description: "Yorqin, ochiq" },
	{ name: "Zubenelgenubi", character: "Casual", description: "Erkin, rasmiy bo'lmagan" },
];

const VOICE_CATALOG: readonly GeminiVoiceOption[] = VOICE_CHARACTERS.map((option) => {
	const phoneClarityDb = PHONE_CLARITY_DB[option.name] ?? null;

	return { ...option, phoneClarityDb, phoneClarity: phoneClarityLabel(phoneClarityDb) };
});

/** Case-insensitive, because a dashboard field is typed by a person. */
function resolveVoice(requested: string | undefined): string {
	const wanted = (requested ?? "").trim();

	if (wanted.length === 0) {
		return DEFAULT_VOICE;
	}

	for (const option of VOICE_CATALOG) {
		if (option.name.toLowerCase() === wanted.toLowerCase()) {
			return option.name;
		}
	}

	logger.warn(
		{ requested: wanted, using: DEFAULT_VOICE },
		"that voice is not a Gemini voice (it is probably an OpenAI one); using the default"
	);

	return DEFAULT_VOICE;
}

// ===========================================
// Live tuning, edited on the AI assistant page
// ===========================================

/**
 * The setting keys this provider reads out of system_settings.
 *
 * Precedence is override > .env > the defaults below, and every read is
 * defensive: a key that is not registered yet, a database that is down, a value
 * of the wrong type or a value out of range all fall back rather than throw.
 * That is deliberate - this code runs while a caller is on the line, so a
 * misconfigured setting must cost a log line, never the call.
 *
 * They are typed as plain strings, not as SettingKey, because the registry is
 * owned elsewhere and an entry may not exist: what the registry knows is decided
 * at runtime, in readStoredTuning(), not by this file's types.
 */
interface TuningKeyMap {
	voice: string;
	providerVoice: string;
	temperature: string;
	topP: string;
	maxOutputTokens: string;
	languageCode: string;
	vadStartSensitivity: string;
	vadEndSensitivity: string;
	vadPrefixPaddingMs: string;
	vadSilenceDurationMs: string;
	dialect: string;
	presenceDb: string;
	outputGainDb: string;
}

const TUNING_KEYS: TuningKeyMap = {
	// Two keys for the voice, checked in this order, because the dashboard may
	// register either a Gemini-specific field or one shared with the other
	// provider. Neither has to exist, and neither is used unless a row was
	// actually saved - see readStoredVoice().
	providerVoice: "ai.gemini.voice",
	voice: "ai.voice",
	temperature: "ai.gemini.temperature",
	topP: "ai.gemini.topP",
	maxOutputTokens: "ai.gemini.maxOutputTokens",
	languageCode: "ai.gemini.languageCode",
	vadStartSensitivity: "ai.gemini.vadStartSensitivity",
	vadEndSensitivity: "ai.gemini.vadEndSensitivity",
	vadPrefixPaddingMs: "ai.gemini.vadPrefixPaddingMs",
	vadSilenceDurationMs: "ai.gemini.vadSilenceDurationMs",
	dialect: "ai.dialect",
	// Not ai.gemini.*: these describe the telephone line, not the model. They live
	// under ai.audio.* so a second provider can read the same two knobs rather than
	// growing its own pair that means the same thing.
	presenceDb: "ai.audio.presenceDb",
	outputGainDb: "ai.audio.outputGainDb",
};

/** The two values the API accepts for each sensitivity; anything else is a 1007. */
type VadStartSensitivity = "START_SENSITIVITY_LOW" | "START_SENSITIVITY_HIGH";
type VadEndSensitivity = "END_SENSITIVITY_LOW" | "END_SENSITIVITY_HIGH";

export interface GeminiLiveTuning {
	/** The voice the dashboard stored, or null when it stored none. */
	voice: string | null;
	temperature: number;
	topP: number;
	maxOutputTokens: number;
	/** Empty means "send no languageCode" - see the default below. */
	languageCode: string;
	startOfSpeechSensitivity: VadStartSensitivity;
	endOfSpeechSensitivity: VadEndSensitivity;
	prefixPaddingMs: number;
	silenceDurationMs: number;
	dialect: AgentDialectId;
	/** Presence-bell lift applied to the agent's own voice, in dB. 0 turns it off. */
	presenceDb: number;
	/** Make-up gain after the bell, in dB. 0 leaves the level alone. */
	outputGainDb: number;
}

/**
 * What a session uses when a key is not in the registry at all.
 *
 * The registry has defaults of its own, and they win whenever the key exists -
 * these are the floor under a deployment whose registry predates a field, so a
 * missing entry degrades to a documented value instead of an undefined one.
 * Every number is a decision about how the agent sounds, so each says why:
 */
const TUNING_DEFAULTS: GeminiLiveTuning = {
	voice: null,
	// Below the API's own 1.0. A receptionist may vary its wording, but this one
	// also quotes prices and opening hours out of a knowledge base, and the higher
	// the temperature the more often a model paraphrases a fact into a wrong one.
	temperature: 0.85,
	topP: 0.95,
	// 0 means "send no cap", which is what every call did before this field
	// existed. It is a speech-length cap rather than a text one - audio output is
	// counted in tokens too - so a small value does not shorten an answer, it cuts
	// it off mid-word. Length is the prompt's job; see MIN_OUTPUT_TOKENS.
	maxOutputTokens: 0,
	// Deliberately empty here: speechConfig.languageCode pins the language the
	// voice speaks, and a business answering Uzbek AND Russian callers on one
	// number is better served by the prompt's "follow the caller" rule. Pin it on
	// the page when a line only ever speaks one language - that is worth doing,
	// because a pinned language noticeably improves the pronunciation.
	languageCode: "",
	// LOW on a telephone line, both ends, for two different reasons. Start: the
	// caller's handset picks up the agent's own voice, and a sensitive detector
	// treats that echo (or street noise) as a barge-in and stops the agent
	// mid-sentence. End: a person pauses for breath in the middle of a thought, and
	// an eager end-of-speech detector answers the first half of their sentence.
	startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
	endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
	// Google documents this as the speech that must be heard before a start is
	// committed, so it is short on purpose: a one-syllable "ha" or "hovva" is a
	// complete answer here and has to be able to trigger a turn.
	prefixPaddingMs: 150,
	// How long a pause may last before the agent takes its turn. Long enough to let
	// somebody breathe mid-sentence, short enough that the answer still feels
	// immediate on a phone line.
	silenceDurationMs: 600,
	dialect: DEFAULT_AGENT_DIALECT,
	// 6 dB at 2.1 kHz. Measured through this exact pipeline rather than chosen by
	// ear - the same audio with the chain off and on, so the resampling is common
	// to both sides and only the filter differs. Change in the consonant-to-vowel
	// ratio, on three sources:
	//
	//   a real 34 s call, this deployment's own voice   -11.5 -> -9.0 dB  (+2.5)
	//   the 296 s recording the complaint came from     -16.0 -> -12.3 dB (+3.7)
	//   raw 24 kHz TTS that never touched the pipeline  -10.6 -> -8.3 dB  (+2.4)
	//
	// Per band on the 296 s recording: 1.2-2 kHz +3.5 dB, 2-3 kHz +5.2 dB,
	// 3-3.6 kHz +5.3 dB, with the vowels below 700 Hz unmoved. 8 and 10 dB buy
	// roughly another dB each and start amplifying the model's own codec noise in
	// a band that had very little signal to begin with, which is a different bad
	// line rather than no bad line.
	presenceDb: 6,
	// +3 dB into a limiter, which is what makes the level CONSISTENT rather than
	// merely louder: quiet passages come up, peaks are held under the ceiling, and
	// speech RMS lands at -13.5 dBFS instead of wandering around -15.6. On the
	// recording that prompted this, it also took the clipped-sample count from
	// four to zero - the chain is a peak REDUCTION, not an increase.
	outputGainDb: 3,
};

interface StoredSetting {
	value: SettingPrimitive;
	/** False when no row exists and the registry's own default is being served. */
	isStored: boolean;
}

type StoredTuning = ReadonlyMap<string, StoredSetting>;

/**
 * Read whichever of the keys above the registry knows, in one pass.
 *
 * listSettings() rather than getSettings() for one reason: it reports whether a
 * row exists. Every value here has a registry default, so without `isStored`
 * "nobody has ever touched this" and "the owner chose exactly this" are the same
 * answer - and for the voice they must not be. An unregistered key is simply
 * absent from the snapshot, which is what lets this work whatever the registry
 * currently holds.
 */
async function readStoredTuning(tenantId: TenantId): Promise<StoredTuning> {
	const wanted = new Set<string>(Object.values(TUNING_KEYS));

	try {
		const snapshot = await listSettings(tenantId);

		return new Map(
			snapshot
				.filter((item) => wanted.has(item.key))
				.map((item) => [item.key as string, { value: item.value, isStored: item.isStored }])
		);
	} catch (cause) {
		logger.warn(
			{ err: cause },
			"the AI tuning settings could not be read; using the built-in defaults"
		);

		return new Map();
	}
}

/**
 * A number from the settings, coerced and clamped.
 *
 * Clamping rather than rejecting, because both failure modes are dropped calls: a
 * value the API refuses closes the socket with 1007 before the caller hears
 * anything, and a maxOutputTokens of 20 truncates every single turn. A clamp
 * plus a log keeps the call alive and tells an operator what was ignored.
 */
function readNumber(
	stored: StoredTuning,
	key: string,
	fallback: number,
	min: number,
	max: number
): number {
	const raw = stored.get(key)?.value;

	if (raw === undefined) {
		return fallback;
	}

	const value = typeof raw === "number" ? raw : Number(String(raw).trim());

	if (!Number.isFinite(value)) {
		logger.warn({ key, raw }, "that AI setting is not a number; using the default");
		return fallback;
	}

	const clamped = Math.min(max, Math.max(min, value));

	if (clamped !== value) {
		logger.warn(
			{ key, value, clamped, min, max },
			"that AI setting is outside the range this provider will send; clamped"
		);
	}

	return clamped;
}

function readText(stored: StoredTuning, key: string): string {
	const raw = stored.get(key)?.value;

	return raw === undefined ? "" : String(raw).trim();
}

/**
 * The floor for a maxOutputTokens the owner actually asked for.
 *
 * Roughly ten seconds of speech. Below this every single turn is cut off
 * mid-word, which is not a shorter answer but a broken one, so a smaller value is
 * clamped and logged rather than honoured. Zero is not clamped: it means "send no
 * cap at all", which the registry documents and which is what production did
 * before this field existed.
 */
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 32_768;

function readMaxOutputTokens(stored: StoredTuning): number {
	const value = readNumber(
		stored,
		TUNING_KEYS.maxOutputTokens,
		TUNING_DEFAULTS.maxOutputTokens,
		0,
		MAX_OUTPUT_TOKENS
	);

	if (value === 0) {
		return 0;
	}

	if (value < MIN_OUTPUT_TOKENS) {
		logger.warn(
			{ value, using: MIN_OUTPUT_TOKENS },
			"that maxOutputTokens would truncate every spoken turn; raising it to the floor"
		);

		return MIN_OUTPUT_TOKENS;
	}

	return Math.round(value);
}

/**
 * The voice the owner saved on the dashboard, or null.
 *
 * Only a STORED row counts. The registry default for this key is whatever
 * GEMINI_LIVE_VOICE said at boot, so honouring the default here would let .env
 * quietly outrank the voice a business chose in its own profile - and the profile
 * dropdown, which has worked all along, would stop doing anything.
 */
function readStoredVoice(stored: StoredTuning): string | null {
	for (const key of [TUNING_KEYS.providerVoice, TUNING_KEYS.voice]) {
		const entry = stored.get(key);

		if (entry?.isStored !== true) {
			continue;
		}

		const value = String(entry.value).trim();

		if (value.length > 0) {
			return value;
		}
	}

	return null;
}

/** BCP-47 as this API spells it: "uz-UZ", "ru-RU". Anything else is not sent at all. */
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function readLanguageCode(stored: StoredTuning): string {
	const value = readText(stored, TUNING_KEYS.languageCode);

	if (value.length === 0) {
		return TUNING_DEFAULTS.languageCode;
	}

	if (!LANGUAGE_CODE_PATTERN.test(value)) {
		logger.warn(
			{ languageCode: value },
			"that is not a BCP-47 language code; sending none and letting the model follow the caller"
		);

		return "";
	}

	return value;
}

/**
 * A stored sensitivity, whichever way it was written.
 *
 * The API knows exactly two values per field and rejects the setup frame for
 * anything else, so this reduces the value to the only bit that carries meaning:
 * "low", "LOW", "START_SENSITIVITY_LOW" and "start-sensitivity-low" are one
 * setting, and "SENSITIVITY_UNSPECIFIED" or a typo is a logged fallback rather
 * than a 1007 the caller pays for.
 */
function readSensitivity<T extends string>(
	stored: StoredTuning,
	key: string,
	low: T,
	high: T,
	fallback: T
): T {
	const value = readText(stored, key);

	if (value.length === 0) {
		return fallback;
	}

	const normalised = value.toLowerCase().replace(/[^a-z]/g, "");

	if (normalised.endsWith("low")) {
		return low;
	}

	if (normalised.endsWith("high")) {
		return high;
	}

	logger.warn({ key, value, using: fallback }, "that VAD sensitivity is not one the API accepts");

	return fallback;
}

/**
 * The effective tuning for the next session.
 *
 * Exported so the dashboard can show what a call would really use instead of
 * echoing back the value it just saved.
 */
export async function getGeminiLiveTuning(tenantId: TenantId): Promise<GeminiLiveTuning> {
	const stored = await readStoredTuning(tenantId);

	return {
		voice: readStoredVoice(stored),
		temperature: readNumber(stored, TUNING_KEYS.temperature, TUNING_DEFAULTS.temperature, 0, 2),
		topP: readNumber(stored, TUNING_KEYS.topP, TUNING_DEFAULTS.topP, 0, 1),
		maxOutputTokens: readMaxOutputTokens(stored),
		languageCode: readLanguageCode(stored),
		startOfSpeechSensitivity: readSensitivity(
			stored,
			TUNING_KEYS.vadStartSensitivity,
			"START_SENSITIVITY_LOW",
			"START_SENSITIVITY_HIGH",
			TUNING_DEFAULTS.startOfSpeechSensitivity
		),
		endOfSpeechSensitivity: readSensitivity(
			stored,
			TUNING_KEYS.vadEndSensitivity,
			"END_SENSITIVITY_LOW",
			"END_SENSITIVITY_HIGH",
			TUNING_DEFAULTS.endOfSpeechSensitivity
		),
		// The ranges match the registry's own, so a value the dashboard accepted is
		// never quietly changed here. They still catch what the registry cannot: a
		// hand-edited row, a value of the wrong type, or a key some future registry
		// bounds differently.
		prefixPaddingMs: readNumber(
			stored,
			TUNING_KEYS.vadPrefixPaddingMs,
			TUNING_DEFAULTS.prefixPaddingMs,
			0,
			5000
		),
		silenceDurationMs: readNumber(
			stored,
			TUNING_KEYS.vadSilenceDurationMs,
			TUNING_DEFAULTS.silenceDurationMs,
			50,
			10_000
		),
		dialect: resolveAgentDialect(readText(stored, TUNING_KEYS.dialect)),
		presenceDb: readNumber(
			stored,
			TUNING_KEYS.presenceDb,
			TUNING_DEFAULTS.presenceDb,
			0,
			PRESENCE_MAX_DB
		),
		outputGainDb: readNumber(
			stored,
			TUNING_KEYS.outputGainDb,
			TUNING_DEFAULTS.outputGainDb,
			0,
			OUTPUT_GAIN_MAX_DB
		),
	};
}

/** Asterisk's rate, which this API accepts directly. */
const INPUT_RATE = 8000;

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * WHERE THE CALLER-VOICE SIGNAL COMES FROM, AND WHY NOT FROM HERE.
 *
 * This API sends no mid-turn activity event. Measured against
 * gemini-3.1-flash-live-preview by replaying the audio of a call that was cut off:
 * fifteen seconds of continuous Uzbek speech produced exactly zero server messages
 * - no inputTranscription, no activity marker, nothing but the periodic
 * sessionResumptionUpdate - and then ONE inputTranscription carrying the whole
 * utterance, two seconds after the caller stopped. Input transcription here is a
 * turn-BOUNDARY event.
 *
 * That event is still reported through onCallerSpeech, because it is true and it
 * is the only evidence the words were UNDERSTOOD rather than merely heard. What it
 * is not is a live "somebody is talking" signal, and nothing depends on it being
 * one: the platform measures that from the caller's own frames, in
 * audiosocket.ts's CallerVoiceActivity, which is the single detector on the
 * platform and owns the 20 ms frame contract those measurements are made in.
 * This file used to measure the same PCM a second time, with a different rule.
 */

interface GeminiPart {
	text?: string;
	inlineData?: { mimeType?: string; data?: string };
}

interface GeminiServerMessage {
	setupComplete?: Record<string, unknown>;
	serverContent?: {
		modelTurn?: { parts?: GeminiPart[] };
		inputTranscription?: { text?: string };
		outputTranscription?: { text?: string };
		interrupted?: boolean;
		turnComplete?: boolean;
		generationComplete?: boolean;
	};
	toolCall?: {
		functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
	};
	usageMetadata?: {
		promptTokenCount?: number;
		responseTokenCount?: number;
		totalTokenCount?: number;
		/** Per-modality breakdown; `modality` is "TEXT" or "AUDIO". Absent on some accounts. */
		promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
		responseTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
		cachedContentTokenCount?: number;
	};
	error?: { code?: number; message?: string; status?: string };
}

/** The seven counters this provider tracks, in one shape so the delta loop is total. */
interface GeminiUsageTotals {
	prompt: number;
	completion: number;
	cached: number;
	inputAudio: number;
	inputText: number;
	outputAudio: number;
	outputText: number;
}

const USAGE_FIELDS = [
	"prompt",
	"completion",
	"cached",
	"inputAudio",
	"inputText",
	"outputAudio",
	"outputText",
] as const satisfies ReadonlyArray<keyof GeminiUsageTotals>;

const EMPTY_USAGE: GeminiUsageTotals = {
	prompt: 0,
	completion: 0,
	cached: 0,
	inputAudio: 0,
	inputText: 0,
	outputAudio: 0,
	outputText: 0,
};

/** Total the entries of one modality. Case-insensitive: the wire says "AUDIO", docs say "audio". */
function sumModality(
	details: Array<{ modality?: string; tokenCount?: number }> | undefined,
	modality: "AUDIO" | "TEXT"
): number {
	let total = 0;

	for (const entry of details ?? []) {
		if ((entry.modality ?? "").toUpperCase() === modality) {
			total += entry.tokenCount ?? 0;
		}
	}

	return total;
}

export interface GeminiLiveProviderOptions {
	/**
	 * Whose call this is.
	 *
	 * Required, not optional. It was resolved with getSoleTenantId() before, which
	 * throws once a second customer exists - and the throw was swallowed into "use
	 * the built-in defaults", so EVERY tenant silently lost its voice, dialect and
	 * temperature the moment the platform had two customers. A required parameter is
	 * what makes that impossible to reintroduce.
	 */
	tenantId: TenantId;
	apiKey?: string;
	model?: string;
	voice?: string;
	agentProfile?: ActiveAgentProfile;
	knowledge?: readonly KnowledgeHit[];
	tools?: readonly RealtimeToolDefinition[];
	/** Overridable so a test can drive the provider without a network. */
	socketFactory?: (url: string) => WebSocket;
	/**
	 * Applied on top of the stored settings. For tests: it is what lets one assert
	 * the exact setup frame a given configuration produces, without a row in
	 * system_settings deciding the outcome.
	 */
	tuning?: Partial<GeminiLiveTuning>;
}

/**
 * The JSON Schema keys Gemini's function declarations understand.
 *
 * It takes a restricted OpenAPI subset, not full JSON Schema, and it rejects the
 * whole setup message rather than ignoring a key it does not know:
 *
 *   1007 Invalid JSON payload received. Unknown name "additionalProperties"
 *        at 'setup.tools[0].function_declarations[0].parameters'
 *
 * A rejected setup is a dead session - no instructions, no tools, no voice - so
 * this list is an allowlist rather than a list of things to strip. Anything the
 * tool definitions grow later is dropped by default instead of killing calls.
 */
const GEMINI_SCHEMA_KEYS = new Set([
	"type",
	"format",
	"description",
	"nullable",
	"enum",
	"items",
	"properties",
	"required",
	"minItems",
	"maxItems",
]);

/** Recursively reduce a JSON Schema to what Gemini accepts. */
function toGeminiSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(toGeminiSchema);
	}

	if (schema === null || typeof schema !== "object") {
		return schema;
	}

	const out: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
		if (!GEMINI_SCHEMA_KEYS.has(key)) {
			continue;
		}

		// `properties` is a map of name -> schema, so its VALUES are schemas while
		// its keys are field names and must survive untouched.
		if (key === "properties" && value !== null && typeof value === "object") {
			const properties: Record<string, unknown> = {};

			for (const [field, sub] of Object.entries(value as Record<string, unknown>)) {
				properties[field] = toGeminiSchema(sub);
			}

			out[key] = properties;
			continue;
		}

		out[key] = key === "items" ? toGeminiSchema(value) : value;
	}

	return out;
}

/**
 * OpenAI's tool shape re-expressed as Gemini function declarations.
 *
 * Only the envelope and the schema dialect differ, so one definition list serves
 * both providers - which is what keeps them answering with the same tools, the
 * same descriptions and the same validators.
 */
function toFunctionDeclarations(tools: readonly RealtimeToolDefinition[]): Array<{
	name: string;
	description: string;
	parameters: unknown;
}> {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: toGeminiSchema(tool.parameters),
	}));
}

function readApiKey(explicit: string | undefined): string {
	return (explicit ?? process.env.GOOGLE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
}

/** Bun delivers binary frames as ArrayBuffer, browsers as Blob; this API sends JSON. */
function decodeFrame(data: unknown): string | null {
	if (typeof data === "string") {
		return data;
	}

	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(data);
	}

	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(data as Uint8Array);
	}

	return null;
}

class GeminiLiveProvider implements VoiceProvider {
	readonly name = GEMINI_LIVE_PROVIDER_NAME;

	/** Whose call this is - the tuning, the profile and the key are all per tenant. */
	private readonly tenantId: TenantId;
	private readonly apiKey: string;
	/** Public so ai_sessions records the model this session really used, not the environment's. */
	readonly model: string;
	/** What the profile or the environment asked for, before the stored override is known. */
	private readonly requestedVoice: string | undefined;
	/**
	 * The voice this session speaks with, final once start() has resolved it.
	 *
	 * Public for the same reason `model` is: ai_sessions should record what the
	 * caller actually heard. It does not yet - the orchestrator writes that row
	 * before start() and reconstructs the voice from the profile, which is right
	 * until a voice is saved on the AI assistant page and then silently is not.
	 * Reading this after start() is the one-line fix, and it lives here so that fix
	 * needs no change in this file.
	 */
	voice: string;
	/** Replaced in start() by whatever the dashboard has stored. */
	private tuning: GeminiLiveTuning = TUNING_DEFAULTS;
	private readonly tuningOverride: Partial<GeminiLiveTuning>;
	private readonly agentProfile: ActiveAgentProfile;
	private readonly knowledge: readonly KnowledgeHit[];
	private readonly tools: readonly RealtimeToolDefinition[];
	private readonly socketFactory: (url: string) => WebSocket;

	private socket: WebSocket | null = null;
	private context: VoiceSessionContext | null = null;
	private handlers: VoiceProviderHandlers | null = null;

	private stopped = false;
	private ready = false;
	private bargeInSuppressed = false;

	/**
	 * The agent's outbound voice: presence bell, limiter, 24 kHz -> 8 kHz.
	 *
	 * ONE INSTANCE PER SESSION, and that matters twice over. The bell, the
	 * limiter and the anti-alias FIR all carry state across samples, so a fresh
	 * object per audio chunk would restart every one of them at each chunk
	 * boundary - the FIR would convolve the first 64 samples of every blob
	 * against a zeroed history and the decimation phase would jump, which is a
	 * few milliseconds of wrong audio dozens of times a second. This field used
	 * to hold the one-shot `downsample24kTo8k`, which did exactly that.
	 *
	 * Replaced in start() once the tuning has been read; a session that never
	 * starts still has a working, transparent chain here.
	 */
	private voiceChain: AgentVoiceChain = createAgentVoiceChain();

	private inputAudioMs = 0;
	private outputAudioMs = 0;
	private interruptions = 0;

	/**
	 * The last usageMetadata seen, so only the delta is reported.
	 *
	 * The Live API reports the token count for the SESSION SO FAR and attaches it
	 * to nearly every server message, while the orchestrator's onUsage accumulates
	 * with `+=` (correct for OpenAI, where response.done reports one response).
	 * Subtracting here keeps that contract identical for both backends instead of
	 * multiplying the true figure by the number of messages.
	 */
	private lastUsage = EMPTY_USAGE;
	/** Set once a field goes DOWN, which proves the account reports per-message, not cumulative. */
	private usageIsPerMessage = false;
	private loggedRawUsage = false;

	/** Partial transcripts, flushed as one row per turn. */
	private callerText = "";
	private agentText = "";

	constructor(options: GeminiLiveProviderOptions) {
		this.tenantId = options.tenantId;
		this.apiKey = readApiKey(options.apiKey);
		this.model = (options.model ?? process.env.GEMINI_LIVE_MODEL ?? DEFAULT_MODEL).trim();
		this.requestedVoice = options.voice ?? process.env.GEMINI_LIVE_VOICE;
		this.voice = resolveVoice(this.requestedVoice);
		this.agentProfile = options.agentProfile ?? unconfiguredAgentProfile();
		this.knowledge = options.knowledge ?? [];
		this.tools = options.tools ?? buildToolDefinitions(this.agentProfile.ticketCategories);
		this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
		this.tuningOverride = options.tuning ?? {};
	}

	async start(context: VoiceSessionContext, handlers: VoiceProviderHandlers): Promise<void> {
		if (this.apiKey.length === 0) {
			throw new VoiceProviderUnavailableError(
				this.name,
				"GOOGLE_AI_API_KEY is not set, so no Gemini Live session can be opened"
			);
		}

		this.context = context;
		this.handlers = handlers;

		// Before the socket, because the whole configuration goes up in one setup
		// frame and there is no second chance to send it. The settings are served from
		// an in-process cache, so this is one query on the first call of the process
		// and nothing at all afterwards.
		this.tuning = { ...(await getGeminiLiveTuning(this.tenantId)), ...this.tuningOverride };
		// The profile wins whenever there is one, because that is where the AI
		// assistant page writes the voice it just saved. A stored ai.gemini.voice row
		// only applies to a deployment with no configured profile - letting it
		// outrank the profile made the dropdown save a voice and then speak a
		// different one, which is the exact class of lie this whole change removes.
		this.voice = resolveVoice(
			this.agentProfile.isConfigured
				? this.requestedVoice
				: (this.tuning.voice ?? this.requestedVoice)
		);

		// The chain has to exist before the first audio part arrives, and it is built
		// from the tuning, so this is the earliest point it can be built.
		this.voiceChain = createAgentVoiceChain({
			presenceDb: this.tuning.presenceDb,
			outputGainDb: this.tuning.outputGainDb,
		});

		const socket = this.socketFactory(`${WS_BASE}?key=${this.apiKey}`);

		this.socket = socket;

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new VoiceProviderUnavailableError(
						this.name,
						`the Gemini Live handshake did not complete within ${CONNECT_TIMEOUT_MS} ms`
					)
				);
			}, CONNECT_TIMEOUT_MS);

			socket.addEventListener("open", () => {
				this.sendSetup(context);
			});

			socket.addEventListener("message", (event) => {
				const raw = decodeFrame((event as MessageEvent).data);

				if (raw === null) {
					return;
				}

				let message: GeminiServerMessage;

				try {
					message = JSON.parse(raw) as GeminiServerMessage;
				} catch {
					logger.warn("a Gemini frame was not JSON, ignoring it");
					return;
				}

				// The handshake resolves on setupComplete and only then; everything
				// after it is ordinary traffic.
				if (message.setupComplete !== undefined && !this.ready) {
					clearTimeout(timer);
					this.ready = true;
					// The whole effective configuration on one line, because "which voice
					// and which knobs did that call actually use" is otherwise
					// unanswerable after the fact: the values come from the database, not
					// from a file anybody can read back.
					logger.info(
						{
							model: this.model,
							voice: this.voice,
							voiceSource: this.tuning.voice === null ? "profile-or-env" : "settings",
							dialect: this.tuning.dialect,
							temperature: this.tuning.temperature,
							topP: this.tuning.topP,
							maxOutputTokens: this.tuning.maxOutputTokens,
							languageCode: this.tuning.languageCode || "(model decides)",
							vad: {
								start: this.tuning.startOfSpeechSensitivity,
								end: this.tuning.endOfSpeechSensitivity,
								prefixPaddingMs: this.tuning.prefixPaddingMs,
								silenceDurationMs: this.tuning.silenceDurationMs,
							},
							audio: this.audioChainSummary(),
						},
						"Gemini Live session ready"
					);
					this.safely("onReady", () => handlers.onReady());
					resolve();
					return;
				}

				this.handleMessage(message);
			});

			socket.addEventListener("error", () => {
				clearTimeout(timer);

				if (!this.ready) {
					reject(
						new VoiceProviderUnavailableError(this.name, "the Gemini Live socket failed to open")
					);
					return;
				}

				this.safely("onError", () => handlers.onError(new Error("Gemini Live socket error")));
			});

			socket.addEventListener("close", (event) => {
				clearTimeout(timer);

				const detail = event as unknown as { code?: number; reason?: string };
				const reason = `gemini-closed:${detail.code ?? 0}`;

				if (!this.ready) {
					reject(
						new VoiceProviderUnavailableError(
							this.name,
							`the Gemini Live socket closed during the handshake (${detail.code ?? 0} ${
								detail.reason ?? ""
							})`.trim()
						)
					);
					return;
				}

				if (!this.stopped) {
					this.safely("onClose", () => handlers.onClose(reason));
				}
			});
		});
	}

	/**
	 * The whole session configuration, sent once.
	 *
	 * The instructions are the SAME ones the OpenAI provider uses - built from the
	 * business profile and its knowledge base - so switching provider never
	 * changes what the agent is allowed to say, only the voice saying it.
	 *
	 * WHAT MUST NEVER BE ADDED HERE. This model validates the setup frame
	 * strictly and answers an unknown field by closing the socket:
	 *
	 *   1007 Invalid JSON payload received. Unknown name "enableAffectiveDialog" at 'setup'
	 *   1007 Invalid JSON payload received. Unknown name "proactivity" at 'setup'
	 *
	 * Both were measured on this account against gemini-3.1-flash-live-preview.
	 * They are the two fields anyone reaching for "make it sound more human" finds
	 * first in Google's documentation, they belong to the native-audio models only,
	 * and sending either one costs the caller the entire call - the session dies
	 * during the handshake, before a single word is spoken. Everything below IS
	 * accepted by this model, individually verified the same way.
	 */
	private sendSetup(context: VoiceSessionContext): void {
		const tuning = this.tuning;
		const speechConfig: Record<string, unknown> = {
			voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
		};

		// Only sent when it was configured: pinning the spoken language fights the
		// prompt's rule about following the caller into their own language, so an
		// empty setting has to mean "no field", not "an empty string".
		if (tuning.languageCode.length > 0) {
			speechConfig.languageCode = tuning.languageCode;
		}

		const generationConfig: Record<string, unknown> = {
			responseModalities: ["AUDIO"],
			temperature: tuning.temperature,
			topP: tuning.topP,
			speechConfig,
		};

		// Zero means "no cap", and the way to send no cap is to send no field: a
		// literal 0 would be a cap of nothing at all.
		if (tuning.maxOutputTokens > 0) {
			generationConfig.maxOutputTokens = tuning.maxOutputTokens;
		}

		this.send({
			setup: {
				model: `models/${this.model}`,
				generationConfig,
				systemInstruction: {
					parts: [
						{
							text: buildSystemInstructions(context, {
								profile: this.agentProfile,
								knowledge: this.knowledge,
								dialect: tuning.dialect,
							}),
						},
					],
				},
				tools: [
					{ functionDeclarations: toFunctionDeclarations(toolsForCall(this.tools, context)) },
				],
				// Turn-taking, which on a phone line is most of what "sounds human"
				// means: how long a pause may last before the agent answers, and how
				// readily the caller's voice stops it mid-sentence. See TUNING_DEFAULTS
				// for why both sensitivities start LOW.
				realtimeInputConfig: {
					automaticActivityDetection: {
						startOfSpeechSensitivity: tuning.startOfSpeechSensitivity,
						endOfSpeechSensitivity: tuning.endOfSpeechSensitivity,
						prefixPaddingMs: tuning.prefixPaddingMs,
						silenceDurationMs: tuning.silenceDurationMs,
					},
				},
				// A ten-minute call is roughly 25 audio tokens a second in each
				// direction, which comes close enough to this model's context window
				// that a long call can be cut off mid-sentence when it fills. With a
				// sliding window the oldest audio is compressed away instead, so the
				// call survives; the price is that the model forgets the very start of
				// a long conversation, and the transcript in the CRM does not.
				contextWindowCompression: { slidingWindow: {} },
				// Both sides transcribed: the caller's words are the CRM record, and
				// the agent's are what the dashboard shows next to the recording.
				inputAudioTranscription: {},
				outputAudioTranscription: {},
			},
		});
	}

	private handleMessage(message: GeminiServerMessage): void {
		if (message.error !== undefined) {
			logger.error({ error: message.error }, "Gemini Live returned an error");
			this.safely("onError", () =>
				this.handlers?.onError(new Error(message.error?.message ?? "Gemini Live error"))
			);
			return;
		}

		if (message.toolCall?.functionCalls !== undefined) {
			// Deliberately not awaited: this is a socket callback, and a tool that
			// takes a second must not stall the audio frames queued behind it.
			this.handleToolCalls(message.toolCall.functionCalls).catch((cause: unknown) => {
				logger.error({ err: cause }, "handling a Gemini tool call failed");
			});
			return;
		}

		const server = message.serverContent;

		if (server === undefined) {
			this.reportUsage(message);
			return;
		}

		// The caller talked over the agent. Gemini has already stopped generating;
		// the orchestrator still has to drop what it handed to Asterisk.
		if (server.interrupted === true && !this.bargeInSuppressed) {
			this.interruptions += 1;
			logger.debug({ interruptions: this.interruptions }, "caller interrupted the agent");
			this.safely("onInterruption", () => this.handlers?.onInterruption());
		}

		if (server.inputTranscription?.text) {
			this.callerText += server.inputTranscription.text;
			// Activity, but only ever at a turn boundary: this model delivers the whole
			// utterance in one message after the caller stops. Kept because it is true
			// and proves the words were understood; the mid-turn signal the guard runs
			// on is measured from the caller's frames instead. See the note above.
			this.safely("onCallerSpeech", () => this.handlers?.onCallerSpeech?.());
		}

		if (server.outputTranscription?.text) {
			this.agentText += server.outputTranscription.text;
		}

		for (const part of server.modelTurn?.parts ?? []) {
			this.handleAudioPart(part);
		}

		if (server.turnComplete === true) {
			// The turn that suppression was protecting is over, so the caller can take
			// the floor again. See suppressBargeIn() for why this is not a latch.
			this.bargeInSuppressed = false;
			this.flushTranscripts();
		}

		this.reportUsage(message);
	}

	/** What the outbound audio chain is doing, for the session-ready log line. */
	private audioChainSummary(): unknown {
		if (this.voiceChain.bypassed) {
			return "off (raw downsample)";
		}

		return {
			presenceDb: this.tuning.presenceDb,
			presenceCentreHz: PRESENCE_CENTRE_HZ,
			outputGainDb: this.tuning.outputGainDb,
		};
	}

	private handleAudioPart(part: GeminiPart): void {
		const encoded = part.inlineData?.data;

		if (encoded === undefined) {
			return;
		}

		const pcm24k = Buffer.from(encoded, "base64");
		const pcm8k = this.voiceChain.process(pcm24k);

		this.outputAudioMs += Math.round(pcm8k.length / 2 / 8);
		this.safely("onAudio", () => this.handlers?.onAudio(pcm8k));
	}

	/** One transcript row per side per turn, rather than a row per fragment. */
	private flushTranscripts(): void {
		this.emitTranscript("caller", this.callerText);
		this.emitTranscript("agent", this.agentText);
		this.callerText = "";
		this.agentText = "";
	}

	private emitTranscript(role: TranscriptRole, content: string): void {
		const text = content.trim();

		if (text.length === 0) {
			return;
		}

		this.safely("onTranscript", () =>
			this.handlers?.onTranscript({ role, content: text, isFinal: true })
		);
	}

	private async handleToolCalls(
		calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
	): Promise<void> {
		const responses: Array<{ id?: string; name: string; response: unknown }> = [];

		for (const call of calls) {
			const name = call.name ?? "";
			// The SAME validators the OpenAI path uses, so a malformed argument is
			// rejected identically no matter which model produced it.
			//
			// The OBJECT, not JSON.stringify of it. The validators zod-parse whatever
			// they are handed, so a string failed every schema with "expected object,
			// received string" - which meant every tool call this provider ever made
			// was rejected, silently, behind a warning nobody read. Gemini already
			// hands us parsed args; the OpenAI path parses its own JSON before getting
			// here, which is where the stringify crept in from.
			const validated = validateToolArguments(name, call.args ?? {});

			if (!validated.ok) {
				logger.warn({ tool: name, detail: validated.error }, "Gemini sent invalid tool arguments");
				responses.push({ id: call.id, name, response: { ok: false, error: validated.error } });
				continue;
			}

			try {
				const result = await this.handlers?.onToolCall({
					name: validated.name,
					toolCallId: call.id ?? validated.name,
					// The validator narrows per tool, so the union is wider than the
					// handler's bag-of-arguments shape; both are the same object.
					args: validated.args as unknown as Record<string, unknown>,
				});

				responses.push({ id: call.id, name, response: result ?? { ok: true } });
			} catch (cause) {
				logger.error({ err: cause, tool: name }, "a Gemini tool call threw");
				responses.push({ id: call.id, name, response: { ok: false, error: "tool failed" } });
			}
		}

		if (responses.length > 0) {
			this.send({ toolResponse: { functionResponses: responses } });
		}
	}

	private reportUsage(message: GeminiServerMessage): void {
		const usage = message.usageMetadata;

		if (usage === undefined) {
			return;
		}

		const current: GeminiUsageTotals = {
			prompt: usage.promptTokenCount ?? 0,
			completion: usage.responseTokenCount ?? 0,
			cached: usage.cachedContentTokenCount ?? 0,
			inputAudio: sumModality(usage.promptTokensDetails, "AUDIO"),
			inputText: sumModality(usage.promptTokensDetails, "TEXT"),
			outputAudio: sumModality(usage.responseTokensDetails, "AUDIO"),
			outputText: sumModality(usage.responseTokensDetails, "TEXT"),
		};

		if (!this.loggedRawUsage) {
			this.loggedRawUsage = true;
			// Once per session, at debug: the documented shape above is not a
			// measurement from this account, and a mapping nobody has seen the wire
			// for is a mapping to distrust.
			logger.debug({ usageMetadata: usage }, "first Gemini usageMetadata of this session");
		}

		const delta = this.resolveUsageDelta(current);

		this.safely("onUsage", () =>
			this.handlers?.onUsage({
				promptTokens: delta.prompt,
				completionTokens: delta.completion,
				cachedTokens: delta.cached,
				inputAudioTokens: delta.inputAudio,
				inputTextTokens: delta.inputText,
				outputAudioTokens: delta.outputAudio,
				outputTextTokens: delta.outputText,
			})
		);
	}

	/**
	 * Turn a session-cumulative report into the per-message increment the
	 * orchestrator's `+=` expects.
	 *
	 * A field going down cannot happen under cumulative reporting, so the first
	 * time it does the account is reporting per message and the value is passed
	 * through verbatim from then on.
	 */
	private resolveUsageDelta(current: GeminiUsageTotals): GeminiUsageTotals {
		if (this.usageIsPerMessage) {
			return current;
		}

		if (USAGE_FIELDS.some((field) => current[field] < this.lastUsage[field])) {
			logger.warn(
				{ current, previous: this.lastUsage },
				"Gemini usageMetadata went down: treating it as per-message rather than cumulative"
			);
			this.usageIsPerMessage = true;
			this.lastUsage = EMPTY_USAGE;

			return current;
		}

		const delta = {} as GeminiUsageTotals;

		for (const field of USAGE_FIELDS) {
			delta[field] = current[field] - this.lastUsage[field];
		}

		this.lastUsage = current;

		return delta;
	}

	pushAudio(slin8k: Buffer): void {
		if (this.stopped || !this.ready || slin8k.length === 0) {
			return;
		}

		this.inputAudioMs += Math.round(slin8k.length / 2 / 8);

		// Straight through: no resampling, because the API takes 8 kHz.
		this.send({
			realtimeInput: {
				audio: {
					data: slin8k.toString("base64"),
					mimeType: `audio/pcm;rate=${INPUT_RATE}`,
				},
			},
		});
	}

	/**
	 * Speak a line the platform wrote, not the model.
	 *
	 * Sent as a user turn with an explicit instruction, the same trick the OpenAI
	 * provider uses: the Live API has no "say this verbatim" primitive either.
	 */
	say(text: string): void {
		const trimmed = text.trim();

		if (this.stopped || trimmed.length === 0) {
			return;
		}

		this.send({
			clientContent: {
				turns: [
					{
						role: "user",
						parts: [
							{
								text:
									"Quyidagi gapni mijozga so'zma-so'z, o'zgartirmasdan ayting. " +
									`Bu ko'rsatmani ovoz chiqarib o'qimang: "${trimmed.replace(/"/g, "'")}"`,
							},
						],
					},
				],
				turnComplete: true,
			},
		});
	}

	cancelResponse(): void {
		// Gemini stops generating on its own when the caller speaks, and exposes no
		// explicit cancel. The audio the caller would still hear is the queue the
		// orchestrator holds, and it drops that through onInterruption.
		this.safely("onInterruption", () => this.handlers?.onInterruption());
	}

	/**
	 * Stop reporting barge-in until the agent's current turn is finished.
	 *
	 * The orchestrator calls this before a transfer or a hangup announcement: that
	 * line is the last thing the caller will hear on this leg, the platform is about
	 * to wait for it to drain, and a cough must not abandon it.
	 *
	 * It clears itself at the next turnComplete rather than staying set, because
	 * "announce, then act" does not always end the call - a transfer that reaches no
	 * operator hands the caller straight back to the agent with the instruction to
	 * take a message instead. Left latched, that caller spends the rest of the call
	 * unable to interrupt the agent at all, on a phone line, which is the one place
	 * interrupting is how people talk.
	 */
	suppressBargeIn(): void {
		this.bargeInSuppressed = true;
	}

	sendToolResult(toolCallId: string, result: unknown): void {
		this.send({
			toolResponse: { functionResponses: [{ id: toolCallId, name: toolCallId, response: result }] },
		});
	}

	async stop(reason: string): Promise<void> {
		if (this.stopped) {
			return;
		}

		this.stopped = true;
		this.flushTranscripts();

		// peakReductionDb is the one number that says whether the limiter earned its
		// place on this call: near 0 dB and it never engaged, past ~12 dB and the
		// make-up gain is set higher than this voice needs.
		logger.info(
			{
				reason,
				...this.stats(),
				// "Was anybody there?" is answered by the orchestrator's own level meter
				// over the same audio, logged when the AudioSocket session ends. Measuring
				// it a second time here is what produced two detectors disagreeing.
				limiterPeakReductionDb: Number(this.voiceChain.peakReductionDb.toFixed(1)),
			},
			"Gemini Live session stopped"
		);

		try {
			this.socket?.close(1000, "session ended");
		} catch {
			/* already closing */
		}

		this.socket = null;
		return Promise.resolve();
	}

	stats(): VoiceProviderStats {
		return {
			inputAudioMs: this.inputAudioMs,
			outputAudioMs: this.outputAudioMs,
			interruptions: this.interruptions,
		};
	}

	/** The greeting text this session would speak, for the orchestrator to use. */
	greetingText(): string {
		return buildGreeting(this.context ?? ({} as VoiceSessionContext), this.agentProfile);
	}

	private send(payload: Record<string, unknown>): void {
		const socket = this.socket;

		if (socket === null || socket.readyState !== 1) {
			return;
		}

		try {
			socket.send(JSON.stringify(payload));
		} catch (cause) {
			logger.error({ err: cause }, "could not write to the Gemini Live socket");
		}
	}

	/** A throwing handler must never take the call down with it. */
	private safely(label: string, run: () => void): void {
		try {
			run();
		} catch (cause) {
			logger.error({ err: cause, handler: label }, "a voice handler threw");
		}
	}
}

export function createGeminiLiveProvider(options: GeminiLiveProviderOptions): VoiceProvider {
	return new GeminiLiveProvider(options);
}

export function isGeminiLiveConfigured(): boolean {
	return readApiKey(undefined).length > 0;
}

/**
 * What a Gemini session would use right now.
 *
 * Exported so the health probe and the /ai-assistant/config response describe
 * the provider that is actually answering calls, instead of reporting OpenAI's
 * model and voice while Gemini is the one on the phone. The key is returned
 * because the probe needs it; it is never put in an HTTP response.
 */
export function getGeminiLiveRuntime(): { apiKey: string; model: string; voice: string } {
	return {
		apiKey: readApiKey(undefined),
		model: (process.env.GEMINI_LIVE_MODEL ?? DEFAULT_MODEL).trim(),
		voice: resolveVoice(process.env.GEMINI_LIVE_VOICE),
	};
}

/**
 * Every voice with its character, for the dashboard's dropdown.
 *
 * Thirty entries is only a usable list if each one says what it sounds like, so
 * this - not the bare names below - is what the AI assistant page should offer.
 */
export const GEMINI_VOICE_CATALOG: readonly GeminiVoiceOption[] = VOICE_CATALOG;

/** The bare names, in the same order. Kept for callers that only need a list. */
export const KNOWN_GEMINI_VOICES: readonly string[] = VOICE_CATALOG.map((option) => option.name);

/** What a session falls back to, and what an empty or unknown voice resolves to. */
export const GEMINI_DEFAULT_VOICE = DEFAULT_VOICE;

/**
 * The name a session would really send for `requested`.
 *
 * Exported so the dashboard can show the voice that will be used rather than the
 * one that was typed - those differ exactly when the stored value is an OpenAI
 * voice, which is the case this function exists for.
 */
export function resolveGeminiVoice(requested: string | undefined): string {
	return resolveVoice(requested);
}
