/**
 * The AI voice agent's effective configuration, resolved on every call.
 *
 * One question, one answer: what should the agent do on the call that is about
 * to start? The answer is assembled from three layers, in this order:
 *
 *   1. a stored row in system_settings   - what a supervisor changed on the page
 *   2. the variable in .env              - what the deployment shipped with
 *   3. the built-in default              - what the code falls back to
 *
 * Layers 2 and 3 are already collapsed into the registry's `default` (see
 * resolveEnvDefault in registry.ts), so this module only has to read the store -
 * which is why there is no precedence branch here to get wrong.
 *
 * WHY A SYNCHRONOUS SNAPSHOT EXISTS. The store is async and the settings are
 * needed in places that cannot await: the silence timer that re-arms on every
 * packet, the language of a spoken line, the greeting delay. So the resolved
 * values are cached in this module and refreshed at the async boundaries that
 * matter - orchestrator start, and once at the top of every call, before a
 * provider is built. Until the first refresh the snapshot holds the .env layer,
 * so a cold read is stale by at most one call and is never a value nobody
 * configured.
 *
 * THE process.env MIRROR, AND ITS TENANT LIMIT. Parts of the voice layer read a
 * handful of variables straight from process.env rather than through a settings
 * call - the provider selector, the Gemini provider's model and voice. Rather than
 * reach into those files, refreshAiRuntimeConfig() writes the resolved values back
 * onto process.env, so those readers see the stored override too. getServerEnv()'s
 * own cache is deliberately untouched: it is the boot-time snapshot the registry
 * defaults were taken from.
 *
 * process.env is PROCESS-WIDE, so with two tenants the mirror would be exactly the
 * cross-tenant leak this phase exists to prevent: the last call to start would set
 * the voice for a call already running. So the mirror is written ONLY while there
 * is a single customer tenant (soleTenantIdOrNull()). With two, it is skipped and
 * those readers fall back to the .env values - a configuration the vendor chose,
 * never another customer's. Removing the mirror entirely is the voice layer's own
 * phase; until then this is the fail-safe direction.
 */
import type { TenantId } from "@shared/types";

import { soleTenantIdOrNull } from "@/lib/tenancy/store";

import {
	AI_DIALECT_LABELS,
	type AiDialect,
	type AiVoiceProviderKind,
	SETTING_DEFINITIONS,
	splitSettingList,
} from "./registry";
import { getSettings } from "./store";

/** Every key this module resolves, and the only keys in the "ai" category. */
export const AI_SETTING_KEYS = [
	"ai.enabled",
	"ai.provider",
	"ai.language",
	"ai.dialect",
	"ai.gemini.voice",
	"ai.gemini.model",
	"ai.openai.voice",
	"ai.openai.model",
	"ai.transcribeModel",
	"ai.analysisModel",
	"ai.maxCallSeconds",
	"ai.silenceHangupMs",
	"ai.greetingDelayMs",
	"ai.agentExtension",
	"ai.transferExtensions",
	"ai.outbound.dialPattern",
	"ai.outbound.callerId",
	"ai.outbound.ringTimeoutSeconds",
	"ai.outbound.maxConcurrentCalls",
	"ai.gemini.temperature",
	"ai.gemini.topP",
	"ai.gemini.maxOutputTokens",
	"ai.gemini.languageCode",
	"ai.gemini.vadStartSensitivity",
	"ai.gemini.vadEndSensitivity",
	"ai.gemini.vadPrefixPaddingMs",
	"ai.gemini.vadSilenceDurationMs",
	"ai.audio.presenceDb",
	"ai.audio.outputGainDb",
] as const;

export type AiSettingKey = (typeof AI_SETTING_KEYS)[number];

/** The stored values, exactly as the store returns them. */
export type AiSettingValues = Awaited<ReturnType<typeof loadAiSettingValues>>;

/** Gemini's speech and turn-taking knobs, in the shape the setup frame wants. */
export interface GeminiSpeechConfig {
	temperature: number;
	topP: number;
	/** 0 means "do not send the field at all". */
	maxOutputTokens: number;
	/** "" means "do not send the field at all". */
	languageCode: string;
	vadStartSensitivity: string;
	vadEndSensitivity: string;
	vadPrefixPaddingMs: number;
	vadSilenceDurationMs: number;
}

/**
 * What the agent's own voice is put through before it reaches the caller.
 *
 * Provider-independent on purpose: it describes the telephone line, not the
 * model. See lib/ai/codec.ts for what the numbers do and how they were measured.
 */
export interface OutboundAudioConfig {
	/** Presence-bell lift at 2.1 kHz, in dB. 0 switches the whole chain off. */
	presenceDb: number;
	/** Make-up gain after the bell, in dB, held under the ceiling by the limiter. */
	outputGainDb: number;
}

/**
 * How the platform places a call of its own.
 *
 * Every field is read per call rather than at boot, which is the whole point:
 * the day a SIP trunk is bought, `dialPattern` changes from "PJSIP/{number}" to
 * "PJSIP/{number}@trunk-<slug>" on the settings page and the next campaign call goes out
 * over the carrier with no deploy and no restart.
 */
export interface OutboundCallConfig {
	/** Dial string template; "{number}" is replaced with the lead's digits. */
	dialPattern: string;
	/** Caller id to present, or "" for "let Asterisk decide". */
	callerId: string;
	ringTimeoutSeconds: number;
	/** Platform-wide ceiling on simultaneous outbound calls. */
	maxConcurrentCalls: number;
}

export interface AiRuntimeConfig {
	enabled: boolean;
	provider: AiVoiceProviderKind;
	language: string;
	dialect: AiDialect;
	/** Human-readable dialect name, for a log line or a spoken-language note. */
	dialectLabel: string;
	geminiVoice: string;
	geminiModel: string;
	openaiVoice: string;
	openaiModel: string;
	transcribeModel: string;
	analysisModel: string;
	maxCallSeconds: number;
	silenceHangupMs: number;
	greetingDelayMs: number;
	agentExtension: string;
	transferExtensions: string[];
	/** How a campaign call is dialled. Not to be confused with `audio`, below. */
	outbound: OutboundCallConfig;
	gemini: GeminiSpeechConfig;
	audio: OutboundAudioConfig;
}

function loadAiSettingValues(tenantId: TenantId) {
	return getSettings(tenantId, AI_SETTING_KEYS);
}

/**
 * Turn the stored values into the shape the voice layer wants.
 *
 * Pure, and exported for the tests: this is where a mis-mapped key would turn a
 * setting into a control that saves and changes nothing.
 */
export function resolveAiRuntimeConfig(values: AiSettingValues): AiRuntimeConfig {
	const dialect = values["ai.dialect"];

	return {
		enabled: values["ai.enabled"],
		provider: values["ai.provider"],
		language: values["ai.language"],
		dialect,
		dialectLabel: AI_DIALECT_LABELS[dialect],
		geminiVoice: values["ai.gemini.voice"],
		geminiModel: values["ai.gemini.model"],
		openaiVoice: values["ai.openai.voice"],
		openaiModel: values["ai.openai.model"],
		transcribeModel: values["ai.transcribeModel"],
		analysisModel: values["ai.analysisModel"],
		maxCallSeconds: values["ai.maxCallSeconds"],
		silenceHangupMs: values["ai.silenceHangupMs"],
		greetingDelayMs: values["ai.greetingDelayMs"],
		agentExtension: values["ai.agentExtension"],
		transferExtensions: splitSettingList(values["ai.transferExtensions"]),
		outbound: {
			dialPattern: values["ai.outbound.dialPattern"],
			callerId: values["ai.outbound.callerId"],
			ringTimeoutSeconds: values["ai.outbound.ringTimeoutSeconds"],
			maxConcurrentCalls: values["ai.outbound.maxConcurrentCalls"],
		},
		gemini: {
			temperature: values["ai.gemini.temperature"],
			topP: values["ai.gemini.topP"],
			maxOutputTokens: values["ai.gemini.maxOutputTokens"],
			languageCode: values["ai.gemini.languageCode"],
			vadStartSensitivity: values["ai.gemini.vadStartSensitivity"],
			vadEndSensitivity: values["ai.gemini.vadEndSensitivity"],
			vadPrefixPaddingMs: values["ai.gemini.vadPrefixPaddingMs"],
			vadSilenceDurationMs: values["ai.gemini.vadSilenceDurationMs"],
		},
		audio: {
			presenceDb: values["ai.audio.presenceDb"],
			outputGainDb: values["ai.audio.outputGainDb"],
		},
	};
}

/**
 * The last resolved configuration PER TENANT.
 *
 * A single slot would answer the wrong tenant's question the moment two calls
 * overlap, and the sync readers below (a silence timer, a spoken line's language)
 * cannot detect that. So it is a Map keyed by tenant, and the key is required at
 * every read.
 *
 * Kept on globalThis so `bun --hot` re-evaluating this module does not throw the
 * snapshots away mid-call and drop back to the .env layer.
 */
const SNAPSHOT_KEY = Symbol.for("callcenter.settings.aiRuntimeSnapshot");

interface Snapshot {
	byTenant: Map<TenantId, AiRuntimeConfig>;
}

const globalStore = globalThis as unknown as Record<symbol, Snapshot | undefined>;

function snapshotSlot(): Snapshot {
	const existing = globalStore[SNAPSHOT_KEY];

	if (existing !== undefined) {
		return existing;
	}

	const created: Snapshot = { byTenant: new Map() };
	globalStore[SNAPSHOT_KEY] = created;

	return created;
}

/**
 * The variables the voice layer still reads straight from process.env.
 *
 * Written on every refresh so a stored override reaches those readers too. The
 * mirror is one-way and additive: nothing here is read back as a source of
 * truth, so a value that stops being mirrored degrades to "the .env value",
 * never to a value nobody chose.
 */
function mirrorOntoProcessEnv(config: AiRuntimeConfig): void {
	process.env.AI_AGENT_ENABLED = config.enabled ? "true" : "false";
	process.env.AI_VOICE_PROVIDER = config.provider;
	process.env.AI_AGENT_LANGUAGE = config.language;
	process.env.GEMINI_LIVE_VOICE = config.geminiVoice;
	process.env.GEMINI_LIVE_MODEL = config.geminiModel;
	process.env.OPENAI_REALTIME_VOICE = config.openaiVoice;
	process.env.OPENAI_REALTIME_MODEL = config.openaiModel;
	process.env.OPENAI_TRANSCRIBE_MODEL = config.transcribeModel;
	process.env.OPENAI_ANALYSIS_MODEL = config.analysisModel;
	process.env.AI_AGENT_EXTENSION = config.agentExtension;
	process.env.AI_TRANSFER_EXTENSIONS = config.transferExtensions.join(",");
	process.env.AI_AGENT_GREETING_DELAY_MS = String(config.greetingDelayMs);
}

/**
 * Re-read the stored settings, refresh the synchronous snapshot and the
 * process.env mirror.
 *
 * Call this at an async boundary before the configuration is used - the
 * orchestrator does it once per call, which is what makes a change on the
 * dashboard take effect on the next caller without a restart.
 */
export async function refreshAiRuntimeConfig(tenantId: TenantId): Promise<AiRuntimeConfig> {
	const config = resolveAiRuntimeConfig(await loadAiSettingValues(tenantId));

	snapshotSlot().byTenant.set(tenantId, config);

	// Only while this is the only customer. See THE process.env MIRROR above.
	if (soleTenantIdOrNull() === tenantId) {
		mirrorOntoProcessEnv(config);
	}

	return config;
}

/**
 * The configuration as last resolved FOR THIS TENANT.
 *
 * Never awaits, so it is safe inside a timer callback or an event handler.
 *
 * `null` is an accepted argument and means "no tenant is known here yet" - the
 * remaining unthreaded sites in the voice layer, marked TODO(tenancy). It returns
 * the registry defaults (the .env layer) rather than picking a tenant, because the
 * only two acceptable answers at a site with no tenant are "the vendor's own
 * default" and "nothing"; another customer's configuration is not on the list. The
 * same is true when the tenant simply has no snapshot yet: stale by at most one
 * refresh, never somebody else's.
 */
export function getAiRuntimeConfig(tenantId: TenantId | null): AiRuntimeConfig {
	const cached = tenantId === null ? undefined : snapshotSlot().byTenant.get(tenantId);

	if (cached === undefined) {
		// Deliberately not awaited and not cached as the snapshot: this path must
		// stay synchronous, and a value that never went through the store must not
		// be mistaken later for one that did.
		return resolveAiRuntimeConfig(registryDefaults());
	}

	return cached;
}

/** Forget a tenant's snapshot, or every one. Used by tests; production refreshes. */
export function clearAiRuntimeConfigSnapshot(tenantId?: TenantId): void {
	if (tenantId) {
		snapshotSlot().byTenant.delete(tenantId);
		return;
	}

	snapshotSlot().byTenant.clear();
}

/**
 * The registry defaults as a values map - the .env layer, with no store access.
 *
 * Read straight from the registry rather than through getSettings() so this stays
 * synchronous. SETTING_DEFINITIONS is typed uniformly, hence the cast: each
 * entry's own schema already guarantees the value type.
 */
function registryDefaults(): AiSettingValues {
	const defaults = {} as Record<AiSettingKey, unknown>;

	for (const key of AI_SETTING_KEYS) {
		defaults[key] = SETTING_DEFINITIONS[key].default;
	}

	return defaults as AiSettingValues;
}
