/**
 * Runtime settings.
 *
 *   import { getSetting } from "@/lib/settings";
 *   const token = await getSetting("notifications.telegram.botToken");
 *
 * Keys, defaults and validation live in registry.ts; persistence and caching in
 * store.ts. Adding a setting means adding one entry to the registry - no
 * migration, no new endpoint, and the Settings page picks it up automatically.
 *
 * ai-config.ts is the one consumer with its own module here, because the voice
 * layer needs these values in places that cannot await. See its header.
 */
export {
	AI_SETTING_KEYS,
	type AiRuntimeConfig,
	type AiSettingKey,
	type AiSettingValues,
	clearAiRuntimeConfigSnapshot,
	type GeminiSpeechConfig,
	getAiRuntimeConfig,
	type OutboundCallConfig,
	refreshAiRuntimeConfig,
	resolveAiRuntimeConfig,
} from "./ai-config";
export {
	AI_DIALECT_LABELS,
	AI_DIALECTS,
	AI_VAD_END_SENSITIVITIES,
	AI_VAD_START_SENSITIVITIES,
	AI_VOICE_PROVIDERS,
	type AiDialect,
	type AiVoiceProviderKind,
	coerceSettingValue,
	getSettingDefinition,
	getSettingKeysByCategory,
	isSettingKey,
	SETTING_CATEGORIES,
	SETTING_CATEGORY_LABELS,
	SETTING_DEFINITIONS,
	SETTING_KEYS,
	SETTINGS_REGISTRY,
	type SettingCategory,
	type SettingDefinition,
	type SettingKey,
	type SettingPrimitive,
	type SettingValueOf,
	type SettingValueType,
} from "./registry";
export {
	getSetting,
	getSettings,
	getSettingsLoadWarnings,
	invalidateSettingsCache,
	listSettings,
	refreshSettings,
	resetSetting,
	type SettingChange,
	type SettingSnapshotItem,
	type SettingWrite,
	setSetting,
	setSettings,
} from "./store";
