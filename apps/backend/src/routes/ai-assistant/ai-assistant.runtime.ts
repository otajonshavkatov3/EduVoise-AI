/**
 * The AI agent's effective configuration, and the only place that changes it.
 *
 * WHERE THE VALUES LIVE. Nothing here is kept in memory any more. Every field is
 * stored, so a change survives a restart - which is the whole point of a
 * configuration page. There are exactly two homes, and which one a field has is
 * decided by where the value is already read from:
 *
 *   system_settings, "ai" category   the deployment's own configuration. The
 *                                    registry's default IS the .env value, so the
 *                                    precedence is a stored row > .env > built-in
 *                                    with no branch to get wrong. See
 *                                    lib/settings/registry.ts.
 *
 *   ai_agent_profiles (active row)   voice, language and the two call limits, but
 *                                    ONLY while a profile row exists. Those four
 *                                    columns are what the orchestrator and the
 *                                    provider actually receive on a call
 *                                    (`profile.isConfigured ? profile.x : env.x`),
 *                                    so writing the setting instead would save
 *                                    happily and change nothing about the next
 *                                    caller. That was the old bug in this file,
 *                                    one layer down: the voice dropdown reported
 *                                    success and the caller still heard the
 *                                    profile's voice.
 *
 * .env is never rewritten. That file belongs to whoever runs the container and a
 * redeploy would revert the edit anyway; it stays the baseline, and the page says
 * so instead of claiming the file changed.
 *
 * WHAT STILL NEEDS A RESTART. Nothing that this endpoint can change:
 * refreshAiRuntimeConfig() re-reads the store at the top of every call and
 * mirrors the values the voice layer reads from process.env, so a change reaches
 * the next caller. Two fields remain read-only and say why on screen instead of
 * offering a control that cannot work - ariApp and audioSocketAdvertiseHost are
 * bound when the orchestrator starts, so changing them means restarting it.
 */
import { getServerEnv } from "@shared/env";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { aiAgentProfiles } from "@/db/schema";
import {
	AGENT_DIALECTS,
	GEMINI_VOICE_CATALOG,
	KNOWN_GEMINI_VOICES,
	phoneClarityLabel,
	resetVoiceProviderHealthCache,
	resolveAgentDialect,
	selectedVoiceProviderName,
} from "@/lib/ai";
import {
	type ActiveAgentProfile,
	getActiveAgentProfile,
	invalidateAgentProfileCache,
} from "@/lib/ai-agent";
import { invalidInput } from "@/lib/errors";
import {
	AI_DIALECT_LABELS,
	AI_DIALECTS,
	AI_VAD_END_SENSITIVITIES,
	AI_VAD_START_SENSITIVITIES,
	AI_VOICE_PROVIDERS,
	type AiRuntimeConfig,
	getSettingDefinition,
	listSettings,
	refreshAiRuntimeConfig,
	type SettingKey,
	type SettingPrimitive,
	type SettingWrite,
	setSettings,
} from "@/lib/settings";
import { type TenantId, tenantWhere } from "@/lib/tenancy";

/** GA Realtime voices. Checked on write, so an unusable name is refused. */
export const KNOWN_REALTIME_VOICES = [
	"alloy",
	"ash",
	"ballad",
	"cedar",
	"coral",
	"echo",
	"marin",
	"sage",
	"shimmer",
	"verse",
] as const;

/** Extensions the shipped dialplan can actually ring - [ai-transfer] matches _1XX and _2XX. */
const DIALPLAN_TRANSFER_PATTERN = /^[12]\d\d$/;

export type AiConfigField =
	| "enabled"
	| "provider"
	| "language"
	| "dialect"
	| "voice"
	| "model"
	| "analysisModel"
	| "transcribeModel"
	| "maxCallSeconds"
	| "silenceHangupMs"
	| "greetingDelayMs"
	| "agentExtension"
	| "transferExtensions"
	| "geminiTemperature"
	| "geminiTopP"
	| "geminiMaxOutputTokens"
	| "geminiLanguageCode"
	| "geminiVadStartSensitivity"
	| "geminiVadEndSensitivity"
	| "geminiVadPrefixPaddingMs"
	| "geminiVadSilenceDurationMs"
	| "audioPresenceDb"
	| "audioOutputGainDb";

/**
 * Where the effective value came from.
 *
 * "env" covers the built-in default too: both mean "nobody has changed this", and
 * the registry makes them the same value.
 */
export type AiConfigSource = "profile" | "override" | "env";

export interface AiConfigNote {
	field: AiConfigField | "ariApp" | "audioSocketAdvertiseHost";
	/** Uzbek, shown under the field. Always a limitation, never reassurance. */
	note: string;
}

/**
 * One choosable voice, with the character that makes it choosable.
 *
 * Thirty Greek and Arabic star names are unpickable as a bare list, so the
 * catalog the provider already keeps is served to the dashboard rather than
 * copied into it - one list, one place to correct.
 */
export interface AiVoiceOption {
	name: string;
	/** Google's own English word for the voice ("Warm", "Gravelly"). "" when unknown. */
	character: string;
	/** The same thing in Uzbek, for the dropdown. "" when unknown. */
	description: string;
	/**
	 * Measured consonant-to-vowel ratio in dB - how much of this voice survives a
	 * 300-3400 Hz telephone line. Null when the voice has never been measured.
	 */
	phoneClarityDb: number | null;
	/** That measurement as one Uzbek phrase, for the picker. */
	phoneClarity: string;
}

/**
 * What the agent's own voice is put through on its way to the caller.
 *
 * Not a Gemini field, and deliberately not inside `gemini`: it describes the
 * telephone line rather than the model. Only the Gemini path runs it today
 * (OpenAI Realtime hands back 8 kHz mu-law that never passes through the
 * resampler), and the note on `audioPresenceDb` says so on screen rather than
 * hiding a control that would do nothing.
 */
export interface OutboundAudioFields {
	/** Presence-bell lift at 2.1 kHz, in dB. 0 switches the whole chain off. */
	presenceDb: number;
	/** Make-up gain after the bell, in dB, held under the ceiling by the limiter. */
	outputGainDb: number;
}

export interface GeminiSpeechFields {
	temperature: number;
	topP: number;
	maxOutputTokens: number;
	languageCode: string;
	vadStartSensitivity: string;
	vadEndSensitivity: string;
	vadPrefixPaddingMs: number;
	vadSilenceDurationMs: number;
}

export interface EffectiveAiConfig {
	enabled: boolean;
	language: string;
	voice: string;
	dialect: string;
	/** The provider that will answer the next call - what `voice` and `model` describe. */
	provider: string;
	/** The configured provider kind ("gemini" / "openai"), even when it cannot run. */
	providerKind: string;
	model: string;
	analysisModel: string;
	transcribeModel: string;
	agentExtension: string;
	transferExtensions: string[];
	maxCallSeconds: number;
	silenceHangupMs: number;
	greetingDelayMs: number;
	gemini: GeminiSpeechFields;
	audio: OutboundAudioFields;
	/** Whether OPENAI_API_KEY is set. The key itself is never exposed. */
	apiKeyConfigured: boolean;
	/** Whether GOOGLE_AI_API_KEY is set. Same rule - the key is never exposed. */
	googleApiKeyConfigured: boolean;
	audioSocketAdvertiseHost: string;
	ariApp: string;
	knownVoices: string[];
	/** The same voices as `knownVoices`, in the same order, with their character. */
	voiceCatalog: AiVoiceOption[];
	options: {
		providers: string[];
		dialects: { value: string; label: string; description: string }[];
		vadStartSensitivities: string[];
		vadEndSensitivities: string[];
	};
	/** The effective value when it is not the .env/built-in baseline, else null. */
	overrides: Record<AiConfigField, SettingPrimitive | null>;
	sources: Record<AiConfigField, AiConfigSource>;
	/** Fields that only reach every consumer after a backend restart. */
	restartRequiredFor: AiConfigField[];
	/** Honest per-field caveats: what a value does NOT do, in Uzbek. */
	notes: AiConfigNote[];
}

export interface AiConfigPatch {
	enabled?: boolean;
	provider?: string;
	language?: string;
	dialect?: string;
	voice?: string;
	model?: string;
	analysisModel?: string;
	transcribeModel?: string;
	maxCallSeconds?: number;
	silenceHangupMs?: number;
	greetingDelayMs?: number;
	agentExtension?: string;
	transferExtensions?: string[];
	gemini?: {
		temperature?: number;
		topP?: number;
		maxOutputTokens?: number;
		languageCode?: string;
		vadStartSensitivity?: string;
		vadEndSensitivity?: string;
		vadPrefixPaddingMs?: number;
		vadSilenceDurationMs?: number;
	};
	audio?: {
		presenceDb?: number;
		outputGainDb?: number;
	};
}

export interface AiRuntimeChange {
	changed: AiConfigField[];
	before: EffectiveAiConfig;
	after: EffectiveAiConfig;
}

// ===========================================
// Field -> storage mapping
// ===========================================

/**
 * The profile column a field lives in while a profile row exists, and the
 * setting key it falls back to when none does.
 */
type ProfileColumn = "voice" | "language" | "maxCallSeconds" | "silenceHangupMs";

interface FieldTarget {
	/** Always present: the deployment-level home. */
	setting: SettingKey;
	/** Present for the four fields the business profile owns at the point of use. */
	profileColumn?: ProfileColumn;
}

/**
 * `voice` and `model` follow the ACTIVE provider.
 *
 * The two vendors have no voice name in common and no model name in common, so
 * one shared key would mean sending OpenAI a Gemini voice the moment the provider
 * was switched - which does not degrade, it fails the session.
 */
function targetFor(field: AiConfigField, provider: string): FieldTarget {
	const gemini = provider === "gemini";

	switch (field) {
		case "enabled":
			return { setting: "ai.enabled" };
		case "provider":
			return { setting: "ai.provider" };
		case "language":
			return { setting: "ai.language", profileColumn: "language" };
		case "dialect":
			return { setting: "ai.dialect" };
		case "voice":
			return {
				setting: gemini ? "ai.gemini.voice" : "ai.openai.voice",
				profileColumn: "voice",
			};
		case "model":
			return { setting: gemini ? "ai.gemini.model" : "ai.openai.model" };
		case "analysisModel":
			return { setting: "ai.analysisModel" };
		case "transcribeModel":
			return { setting: "ai.transcribeModel" };
		case "maxCallSeconds":
			return { setting: "ai.maxCallSeconds", profileColumn: "maxCallSeconds" };
		case "silenceHangupMs":
			return { setting: "ai.silenceHangupMs", profileColumn: "silenceHangupMs" };
		case "greetingDelayMs":
			return { setting: "ai.greetingDelayMs" };
		case "agentExtension":
			return { setting: "ai.agentExtension" };
		case "transferExtensions":
			return { setting: "ai.transferExtensions" };
		case "geminiTemperature":
			return { setting: "ai.gemini.temperature" };
		case "geminiTopP":
			return { setting: "ai.gemini.topP" };
		case "geminiMaxOutputTokens":
			return { setting: "ai.gemini.maxOutputTokens" };
		case "geminiLanguageCode":
			return { setting: "ai.gemini.languageCode" };
		case "geminiVadStartSensitivity":
			return { setting: "ai.gemini.vadStartSensitivity" };
		case "geminiVadEndSensitivity":
			return { setting: "ai.gemini.vadEndSensitivity" };
		case "geminiVadPrefixPaddingMs":
			return { setting: "ai.gemini.vadPrefixPaddingMs" };
		case "geminiVadSilenceDurationMs":
			return { setting: "ai.gemini.vadSilenceDurationMs" };
		case "audioPresenceDb":
			return { setting: "ai.audio.presenceDb" };
		default:
			return { setting: "ai.audio.outputGainDb" };
	}
}

const ALL_FIELDS: AiConfigField[] = [
	"enabled",
	"provider",
	"language",
	"dialect",
	"voice",
	"model",
	"analysisModel",
	"transcribeModel",
	"maxCallSeconds",
	"silenceHangupMs",
	"greetingDelayMs",
	"agentExtension",
	"transferExtensions",
	"geminiTemperature",
	"geminiTopP",
	"geminiMaxOutputTokens",
	"geminiLanguageCode",
	"geminiVadStartSensitivity",
	"geminiVadEndSensitivity",
	"geminiVadPrefixPaddingMs",
	"geminiVadSilenceDurationMs",
	"audioPresenceDb",
	"audioOutputGainDb",
];

// ===========================================
// Reading
// ===========================================

interface ConfigInputs {
	config: AiRuntimeConfig;
	profile: ActiveAgentProfile;
	/** Setting keys with a stored row, i.e. changed away from the .env baseline. */
	stored: Set<SettingKey>;
}

async function readInputs(tenantId: TenantId): Promise<ConfigInputs> {
	const [config, profile, snapshot] = await Promise.all([
		refreshAiRuntimeConfig(tenantId),
		getActiveAgentProfile(tenantId),
		listSettings(tenantId, "ai"),
	]);

	return {
		config,
		profile,
		stored: new Set(snapshot.filter((item) => item.isStored).map((item) => item.key)),
	};
}

/** The voices the active provider accepts. Not advisory - writes are checked against it. */
function knownVoicesFor(provider: string): string[] {
	return provider === "gemini" ? [...KNOWN_GEMINI_VOICES] : [...KNOWN_REALTIME_VOICES];
}

/**
 * The same voices with the character Google publishes for each, and with the
 * phone clarity measured for each on this account.
 *
 * OpenAI's Realtime voices get their names and nothing else: that vendor
 * publishes no character, nobody has measured one on this account, and an
 * invented adjective next to a voice name is read as fact. The same rule governs
 * the clarity figure - null and "O'lchanmagan", not a plausible number.
 */
function voiceCatalogFor(provider: string): AiVoiceOption[] {
	if (provider === "gemini") {
		return GEMINI_VOICE_CATALOG.map((option) => ({
			name: option.name,
			character: option.character,
			description: option.description,
			phoneClarityDb: option.phoneClarityDb,
			phoneClarity: option.phoneClarity,
		}));
	}

	return KNOWN_REALTIME_VOICES.map((name) => ({
		name,
		character: "",
		description: "",
		phoneClarityDb: null,
		phoneClarity: phoneClarityLabel(null),
	}));
}

/**
 * The dialect list, each entry carrying the word forms it actually changes.
 *
 * The label comes from the settings registry (which owns the closed list the
 * PATCH validates against) and the description from the prompt builder (which
 * owns the forms), so neither is retyped here.
 */
function dialectOptions(): { value: string; label: string; description: string }[] {
	return AI_DIALECTS.map((value) => {
		const resolved = resolveAgentDialect(value);
		const option = AGENT_DIALECTS.find((item) => item.id === resolved);

		return { value, label: AI_DIALECT_LABELS[value], description: option?.description ?? "" };
	});
}

/**
 * Whether the active profile's own column decides this field.
 *
 * It mirrors the point of use exactly, including the `> 0` guard the orchestrator
 * applies to the two limits (see maxCallMs / silenceHangupMs there): a profile
 * that stores 0 means "no limit of my own", and then the deployment's value is
 * what the caller actually gets. Reporting anything else here would make this
 * endpoint describe a call it is not describing.
 */
function profileDecides(profile: ActiveAgentProfile, column: ProfileColumn): boolean {
	if (!profile.isConfigured) {
		return false;
	}

	if (column === "maxCallSeconds" || column === "silenceHangupMs") {
		return profile[column] > 0;
	}

	return true;
}

/** The value in effect for one field, and where it came from. */
function effectiveField(
	field: AiConfigField,
	inputs: ConfigInputs
): { value: SettingPrimitive; source: AiConfigSource } {
	const { config, profile, stored } = inputs;
	const target = targetFor(field, config.provider);

	if (target.profileColumn !== undefined && profileDecides(profile, target.profileColumn)) {
		return { value: profile[target.profileColumn], source: "profile" };
	}

	const value = settingValue(field, config);

	return { value, source: stored.has(target.setting) ? "override" : "env" };
}

type FieldState = Record<AiConfigField, { value: SettingPrimitive; source: AiConfigSource }>;

/** Every field's effective value and source, for the response and the change list. */
function effectiveState(inputs: ConfigInputs): FieldState {
	const state = {} as FieldState;

	for (const field of ALL_FIELDS) {
		state[field] = effectiveField(field, inputs);
	}

	return state;
}

/** The deployment-level value, straight off the resolved runtime config. */
function settingValue(field: AiConfigField, config: AiRuntimeConfig): SettingPrimitive {
	const gemini = config.provider === "gemini";

	switch (field) {
		case "enabled":
			return config.enabled;
		case "provider":
			return config.provider;
		case "language":
			return config.language;
		case "dialect":
			return config.dialect;
		case "voice":
			return gemini ? config.geminiVoice : config.openaiVoice;
		case "model":
			return gemini ? config.geminiModel : config.openaiModel;
		case "analysisModel":
			return config.analysisModel;
		case "transcribeModel":
			return config.transcribeModel;
		case "maxCallSeconds":
			return config.maxCallSeconds;
		case "silenceHangupMs":
			return config.silenceHangupMs;
		case "greetingDelayMs":
			return config.greetingDelayMs;
		case "agentExtension":
			return config.agentExtension;
		case "transferExtensions":
			return config.transferExtensions.join(",");
		case "geminiTemperature":
			return config.gemini.temperature;
		case "geminiTopP":
			return config.gemini.topP;
		case "geminiMaxOutputTokens":
			return config.gemini.maxOutputTokens;
		case "geminiLanguageCode":
			return config.gemini.languageCode;
		case "geminiVadStartSensitivity":
			return config.gemini.vadStartSensitivity;
		case "geminiVadEndSensitivity":
			return config.gemini.vadEndSensitivity;
		case "geminiVadPrefixPaddingMs":
			return config.gemini.vadPrefixPaddingMs;
		case "geminiVadSilenceDurationMs":
			return config.gemini.vadSilenceDurationMs;
		case "audioPresenceDb":
			return config.audio.presenceDb;
		default:
			return config.audio.outputGainDb;
	}
}

/**
 * The caveats worth printing next to a field.
 *
 * Only limitations go in here. A note that says "this works" is noise; a missing
 * note about a value that does nothing is the defect this whole endpoint exists
 * to remove.
 */
function buildNotes(inputs: ConfigInputs, effective: EffectiveAiConfig): AiConfigNote[] {
	const notes: AiConfigNote[] = [];
	const { profile, config } = inputs;

	notes.push({
		field: "agentExtension",
		note:
			`Qo'ng'iroqni AI ga yo'naltirishni Asterisk dialplan'i qiladi («exten => ${effective.agentExtension}»). ` +
			"Bu yerdagi qiymat backendga «bu raqam — AI o'zi» deb aytadi; raqamni almashtirsangiz " +
			"extensions.conf ni ham tahrirlab Asterisk'ni reload qilish kerak.",
	});

	notes.push({
		field: "ariApp",
		note:
			`ARI ilova nomi («${effective.ariApp}») va AudioSocket manzili («${effective.audioSocketAdvertiseHost}») ` +
			"faqat .env orqali o'zgaradi: ikkalasi ham orchestrator ishga tushganda Asterisk bilan " +
			"bog'lanadi, ya'ni yangi qiymat backend restartidan keyin kuchga kiradi.",
	});

	if (profile.isConfigured) {
		notes.push({
			field: "voice",
			note:
				`Ovoz, til va qo'ng'iroq chegaralari «${profile.businessName}» biznes profilida saqlanadi — ` +
				"bu yerda o'zgartirsangiz profil yozuvi yangilanadi va «Biznes profili» bo'limida ham " +
				"shu qiymat ko'rinadi.",
		});
	}

	// Two entries, one prompt block. Distinguishing them would mean inventing
	// markers nobody here can vouch for, so the overlap is stated instead of hidden.
	if (effective.dialect === "samarqand" || effective.dialect === "buxoro") {
		notes.push({
			field: "dialect",
			note:
				"Samarqand va Buxoro shevalari hozir bir xil so'z shakllaridan foydalanadi — ikkalasini " +
				"tanlash bir xil natija beradi.",
		});
	}

	const foreignVoice = !knownVoicesFor(config.provider).includes(effective.voice);

	if (foreignVoice) {
		notes.push({
			field: "voice",
			note:
				`«${effective.voice}» — hozirgi provayder (${config.provider}) ovozlari ro'yxatida yo'q. ` +
				"Provayder bunday nomni o'z standart ovoziga almashtiradi, ya'ni mijoz boshqa ovozni eshitadi. " +
				"Ro'yxatdan ovoz tanlang.",
		});
	}

	// The chain lives in the 24 kHz -> 8 kHz resampler, and only the Gemini path
	// has one: OpenAI Realtime is asked for mu-law and returns audio already at
	// the line's own rate. So on that provider these two are stored and inert.
	if (config.provider !== "gemini") {
		notes.push({
			field: "audioPresenceDb",
			note:
				"Hozirgi provayder OpenAI: tiniqlik filtri va balandlik faqat Gemini ovoz oqimiga " +
				"qo'llanadi (OpenAI allaqachon 8 kHz telefon formatida audio qaytaradi). Qiymatlar " +
				"saqlanadi va Gemini provayderiga qaytilganda ishlaydi.",
		});
	} else if (effective.audio.presenceDb === 0) {
		notes.push({
			field: "audioPresenceDb",
			note:
				"0 — tiniqlik filtri butunlay o'chirilgan: ovoz modeldan qanday chiqsa, mijoz shuni " +
				"eshitadi. O'lchovda undosh tovushlar diapazoni (1200–3400 Hz) shu holatda 15–32 dB " +
				"past chiqadi, ya'ni «xira» eshitiladi.",
		});
	}

	if (config.provider === "gemini") {
		notes.push({
			field: "transcribeModel",
			note:
				"Hozirgi provayder Gemini: transkripsiyani model suhbat ichida bajaradi, ya'ni bu model " +
				"ishlatilmaydi. Qiymat OpenAI provayderiga qaytilganda kerak bo'ladi.",
		});

		if (!effective.googleApiKeyConfigured) {
			notes.push({
				field: "provider",
				note:
					"GOOGLE_AI_API_KEY .env da yo'q, shuning uchun Gemini sessiyasi ochilmaydi va har bir " +
					"qo'ng'iroq IVR zaxirasiga tushadi.",
			});
		}
	}

	if (!effective.apiKeyConfigured) {
		notes.push({
			field: "analysisModel",
			note:
				"OPENAI_API_KEY .env da yo'q: qo'ng'iroqdan keyingi tahlil (xulosa, kayfiyat, toifa) " +
				"ishlamaydi — provayder Gemini bo'lsa ham tahlil OpenAI orqali yoziladi.",
		});
	}

	const undiallable = effective.transferExtensions.filter(
		(extension) => !DIALPLAN_TRANSFER_PATTERN.test(extension)
	);

	if (undiallable.length > 0) {
		notes.push({
			field: "transferExtensions",
			note:
				`Dialplan hozir faqat 1XX va 2XX raqamlarini uzatadi, shuning uchun ${undiallable.join(", ")} ` +
				"raqam(lar)iga uzatish urinishi muvaffaqiyatsiz bo'ladi.",
		});
	}

	if (profile.isConfigured && (profile.maxCallSeconds <= 0 || profile.silenceHangupMs <= 0)) {
		notes.push({
			field: "maxCallSeconds",
			note: "Biznes profilidagi chegara 0 bo'lsa e'tiborga olinmaydi va shu bo'limdagi qiymat ishlatiladi.",
		});
	}

	return notes;
}

export async function getEffectiveAiConfig(tenantId: TenantId): Promise<EffectiveAiConfig> {
	return build(await readInputs(tenantId));
}

function build(inputs: ConfigInputs): EffectiveAiConfig {
	const { config } = inputs;
	const env = getServerEnv();
	const state = effectiveState(inputs);

	const overrides = {} as Record<AiConfigField, SettingPrimitive | null>;
	const sources = {} as Record<AiConfigField, AiConfigSource>;

	for (const field of ALL_FIELDS) {
		const { value, source } = state[field];

		overrides[field] = source === "env" ? null : value;
		sources[field] = source;
	}

	const effective: EffectiveAiConfig = {
		enabled: config.enabled,
		language: String(state.language.value),
		voice: String(state.voice.value),
		dialect: config.dialect,
		provider: selectedVoiceProviderName(),
		providerKind: config.provider,
		model: String(state.model.value),
		analysisModel: config.analysisModel,
		transcribeModel: config.transcribeModel,
		agentExtension: config.agentExtension,
		transferExtensions: config.transferExtensions,
		maxCallSeconds: Number(state.maxCallSeconds.value),
		silenceHangupMs: Number(state.silenceHangupMs.value),
		greetingDelayMs: config.greetingDelayMs,
		gemini: { ...config.gemini },
		audio: { ...config.audio },
		apiKeyConfigured: (env.OPENAI_API_KEY ?? "").trim().length > 0,
		googleApiKeyConfigured: hasGoogleApiKey(),
		audioSocketAdvertiseHost: env.AUDIOSOCKET_ADVERTISE_HOST,
		ariApp: env.ASTERISK_ARI_APP,
		knownVoices: knownVoicesFor(config.provider),
		voiceCatalog: voiceCatalogFor(config.provider),
		options: {
			providers: [...AI_VOICE_PROVIDERS],
			dialects: dialectOptions(),
			vadStartSensitivities: [...AI_VAD_START_SENSITIVITIES],
			vadEndSensitivities: [...AI_VAD_END_SENSITIVITIES],
		},
		overrides,
		sources,
		// Every field this endpoint can write is read again on the next call, so
		// there is nothing honest to put here. It stays in the response because a
		// future field might need it, and an empty list is a claim the UI can trust.
		restartRequiredFor: [],
		notes: [],
	};

	effective.notes = buildNotes(inputs, effective);

	return effective;
}

function hasGoogleApiKey(): boolean {
	return (process.env.GOOGLE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim().length > 0;
}

// ===========================================
// Writing
// ===========================================

/**
 * The checks no schema can make, because they depend on the rest of the system
 * rather than on the value alone - and the one normalisation that goes with them.
 *
 * Each refusal here is a value that would otherwise be accepted, stored, and then
 * quietly ignored, which is the failure this endpoint exists to stop. So they are
 * 400s with a reason, not warnings in a log nobody reads.
 *
 * Returns the value to store, which for a voice is the vendor's own spelling:
 * "callirrhoe" from a curl is the voice the caller meant, and refusing it over a
 * capital letter would be pedantry, but storing it as typed would hand the
 * provider a name it substitutes away.
 */
function prepareValue(
	field: AiConfigField,
	value: SettingPrimitive,
	provider: string
): SettingPrimitive {
	if (field === "voice") {
		const known = knownVoicesFor(provider);
		const wanted = String(value).trim().toLowerCase();
		const match = known.find((name) => name.toLowerCase() === wanted);

		if (match === undefined) {
			throw invalidInput(
				"voice",
				`«${String(value)}» — ${provider} provayderida bunday ovoz yo'q. Mumkin: ${known.join(", ")}`
			);
		}

		return match;
	}

	if (field === "provider") {
		if (value === "gemini" && !hasGoogleApiKey()) {
			throw invalidInput(
				"provider",
				"Gemini tanlash uchun .env da GOOGLE_AI_API_KEY bo'lishi kerak, aks holda har bir qo'ng'iroq IVR zaxirasiga tushadi"
			);
		}

		if (value === "openai" && (getServerEnv().OPENAI_API_KEY ?? "").trim().length === 0) {
			throw invalidInput(
				"provider",
				"OpenAI tanlash uchun .env da OPENAI_API_KEY bo'lishi kerak, aks holda har bir qo'ng'iroq IVR zaxirasiga tushadi"
			);
		}
	}

	// agentExtension is deliberately NOT checked against the dialplan: the dialplan
	// is a file the deployment owns and may already have been edited, so refusing
	// here would block a legitimate move. The field's note says what else must
	// change instead.

	return value;
}

/** The patch as a flat list of fields, so validation and audit see one shape. */
function flatten(patch: AiConfigPatch): { field: AiConfigField; value: SettingPrimitive }[] {
	const items: { field: AiConfigField; value: SettingPrimitive }[] = [];

	const push = (field: AiConfigField, value: SettingPrimitive | undefined): void => {
		if (value !== undefined) {
			items.push({ field, value });
		}
	};

	push("enabled", patch.enabled);
	push("provider", patch.provider);
	push("language", patch.language);
	push("dialect", patch.dialect);
	push("voice", patch.voice);
	push("model", patch.model);
	push("analysisModel", patch.analysisModel);
	push("transcribeModel", patch.transcribeModel);
	push("maxCallSeconds", patch.maxCallSeconds);
	push("silenceHangupMs", patch.silenceHangupMs);
	push("greetingDelayMs", patch.greetingDelayMs);
	push("agentExtension", patch.agentExtension);

	if (patch.transferExtensions !== undefined) {
		items.push({ field: "transferExtensions", value: patch.transferExtensions.join(",") });
	}

	const gemini = patch.gemini;

	if (gemini !== undefined) {
		push("geminiTemperature", gemini.temperature);
		push("geminiTopP", gemini.topP);
		push("geminiMaxOutputTokens", gemini.maxOutputTokens);
		push("geminiLanguageCode", gemini.languageCode);
		push("geminiVadStartSensitivity", gemini.vadStartSensitivity);
		push("geminiVadEndSensitivity", gemini.vadEndSensitivity);
		push("geminiVadPrefixPaddingMs", gemini.vadPrefixPaddingMs);
		push("geminiVadSilenceDurationMs", gemini.vadSilenceDurationMs);
	}

	const audio = patch.audio;

	if (audio !== undefined) {
		push("audioPresenceDb", audio.presenceDb);
		push("audioOutputGainDb", audio.outputGainDb);
	}

	return items;
}

/** ai_agent_profiles takes the four columns it owns, in its own column types. */
interface ProfileUpdate {
	voice?: string;
	language?: string;
	maxCallSeconds?: number;
	silenceHangupMs?: number;
	updatedAt: Date;
}

/**
 * Put one validated value into the profile update.
 *
 * The narrowing is per column rather than one cast, so a field mapped to the
 * wrong column - a number into `voice` - fails to compile instead of writing
 * "600" into a voice name.
 */
function setProfileColumn(
	update: ProfileUpdate,
	column: ProfileColumn,
	value: SettingPrimitive
): void {
	if (column === "voice") {
		update.voice = String(value);
		return;
	}

	if (column === "language") {
		update.language = String(value);
		return;
	}

	update[column] = Number(value);
}

/**
 * Apply a patch.
 *
 * The provider is resolved from the patch itself when it is being switched in the
 * same request, so `{ provider: "openai", voice: "cedar" }` validates the voice
 * against OpenAI rather than against the provider that is on its way out.
 */
export async function applyAiConfigPatch(
	tenantId: TenantId,
	patch: AiConfigPatch,
	updatedBy: string | null
): Promise<AiRuntimeChange> {
	const inputs = await readInputs(tenantId);
	const before = build(inputs);
	const provider = patch.provider ?? inputs.config.provider;

	const items = flatten(patch);
	const writes: SettingWrite[] = [];
	const profileUpdate: ProfileUpdate = { updatedAt: new Date() };
	let profileTouched = false;

	for (const item of items) {
		const value = prepareValue(item.field, item.value, provider);
		const target = targetFor(item.field, provider);
		const definition = getSettingDefinition(target.setting);
		// The registry schema is the authority even for a value on its way to the
		// profile: one definition of "a valid voice", whichever table stores it.
		const parsed = definition.schema.safeParse(value);

		if (!parsed.success) {
			// The registry's own message, in Uzbek, naming the field the UI sent.
			throw invalidInput(item.field, parsed.error.issues[0]?.message ?? "qiymat yaroqsiz");
		}

		if (target.profileColumn !== undefined && inputs.profile.isConfigured) {
			setProfileColumn(profileUpdate, target.profileColumn, parsed.data);
			profileTouched = true;
			continue;
		}

		writes.push({ key: target.setting, value: parsed.data });
	}

	if (writes.length > 0) {
		await setSettings(tenantId, writes, updatedBy);
	}

	if (profileTouched && inputs.profile.id !== null) {
		await db
			.update(aiAgentProfiles)
			.set(profileUpdate)
			.where(tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.id, inputs.profile.id)));
		// Same rule the ai-agent routes follow: the next caller, not the next restart.
		invalidateAgentProfileCache(tenantId);
	}

	const inputsAfter = await readInputs(tenantId);
	const after = build(inputsAfter);

	// Compared on the EFFECTIVE value, not on what was sent: saving the value a
	// field already had must report no change, and a field whose value moved
	// because the provider was switched in the same request must report one.
	const stateBefore = effectiveState(inputs);
	const stateAfter = effectiveState(inputsAfter);
	const changed = ALL_FIELDS.filter(
		(field) => stateBefore[field].value !== stateAfter[field].value
	);

	if (changed.length > 0) {
		// The cached probe answered for the old configuration.
		resetVoiceProviderHealthCache();
	}

	return { changed, before, after };
}
