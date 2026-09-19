/**
 * The two things that make the AI settings page honest.
 *
 * PRECEDENCE. A stored row beats .env beats the built-in default. Layers 2 and 3
 * are collapsed into the registry's `default` by resolveEnvDefault(), so they are
 * tested here directly; layer 1 needs a database and is covered by
 * tests/integration/ai-settings.test.ts.
 *
 * VALIDATION. Every value refused below is one that would otherwise be accepted,
 * stored, and then quietly ignored - a Gemini model with no live endpoint, a
 * transcription model that cannot transcribe, an extension list the dialler
 * cannot parse. Those are the bugs this category exists to remove, so refusing
 * them is behaviour worth a test rather than an implementation detail.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";

import { AI_SETTING_KEYS, type AiSettingValues, resolveAiRuntimeConfig } from "./ai-config";
import {
	AI_DIALECTS,
	getSettingKeysByCategory,
	resolveEnvDefault,
	SETTING_DEFINITIONS,
	SETTINGS_REGISTRY,
	type SettingKey,
	type SettingPrimitive,
	splitSettingList,
} from "./registry";

/** The first message a rejected value produces, or null when it was accepted. */
function refusal(key: SettingKey, value: SettingPrimitive): string | null {
	const parsed = SETTING_DEFINITIONS[key].schema.safeParse(value);

	return parsed.success ? null : (parsed.error.issues[0]?.message ?? "");
}

function accepted(key: SettingKey, value: SettingPrimitive): SettingPrimitive {
	const parsed = SETTING_DEFINITIONS[key].schema.safeParse(value);

	if (!parsed.success) {
		throw new Error(`${key} refused ${String(value)}: ${parsed.error.issues[0]?.message}`);
	}

	return parsed.data;
}

// ===========================================
// Precedence: .env over the built-in default
// ===========================================

describe("the .env layer", () => {
	const language = z
		.string()
		.trim()
		.regex(/^[a-z]{2,3}$/);
	const seconds = z.number().int().min(30).max(7200);
	const flag = z.boolean();

	test("a value from .env wins over the built-in default", () => {
		expect(resolveEnvDefault(language, "ru", "uz")).toBe("ru");
		expect(resolveEnvDefault(seconds, "600", 900)).toBe(600);
		expect(resolveEnvDefault(flag, "false", true)).toBe(false);
	});

	test("an unset or empty variable leaves the built-in default", () => {
		expect(resolveEnvDefault(language, undefined, "uz")).toBe("uz");
		expect(resolveEnvDefault(language, "   ", "uz")).toBe("uz");
	});

	test("a value .env cannot express falls back instead of poisoning the registry", () => {
		// A typo in .env must not make a setting - and with it every read of the
		// registry - fail at import time.
		expect(resolveEnvDefault(language, "uzbek-latin", "uz")).toBe("uz");
		expect(resolveEnvDefault(seconds, "not-a-number", 900)).toBe(900);
		expect(resolveEnvDefault(seconds, "5", 900)).toBe(900);
	});

	test("only .env's own spellings of true are true", () => {
		expect(resolveEnvDefault(flag, "true", false)).toBe(true);
		expect(resolveEnvDefault(flag, "1", false)).toBe(true);
		expect(resolveEnvDefault(flag, "ON", false)).toBe(true);
		expect(resolveEnvDefault(flag, "maybe", true)).toBe(false);
	});

	test("every registered default satisfies its own schema", () => {
		for (const key of getSettingKeysByCategory("ai")) {
			expect(refusal(key, SETTING_DEFINITIONS[key].default)).toBeNull();
		}
	});
});

// ===========================================
// Every key reaches the voice layer
// ===========================================

describe("the resolved runtime config", () => {
	test("resolves exactly the keys the registry puts in the ai category", () => {
		// A key in the category that nothing resolves is a control that saves and
		// changes nothing, which is the whole failure mode this category replaced.
		const resolved: string[] = [...AI_SETTING_KEYS];

		expect(resolved.sort()).toEqual([...getSettingKeysByCategory("ai")].sort());
	});

	function values(overrides: Partial<AiSettingValues> = {}): AiSettingValues {
		const base = {} as Record<string, SettingPrimitive>;

		for (const key of AI_SETTING_KEYS) {
			base[key] = SETTING_DEFINITIONS[key].default;
		}

		return { ...(base as unknown as AiSettingValues), ...overrides };
	}

	test("each field is taken from its own key", () => {
		const config = resolveAiRuntimeConfig(
			values({
				"ai.enabled": false,
				"ai.provider": "gemini",
				"ai.language": "ru",
				"ai.dialect": "xorazm",
				"ai.gemini.voice": "Sulafat",
				"ai.gemini.model": "gemini-3.1-flash-live-preview",
				"ai.openai.voice": "cedar",
				"ai.openai.model": "gpt-realtime",
				"ai.transcribeModel": "whisper-1",
				"ai.analysisModel": "gpt-4o-mini",
				"ai.maxCallSeconds": 300,
				"ai.silenceHangupMs": 9000,
				"ai.greetingDelayMs": 250,
				"ai.agentExtension": "900",
				"ai.transferExtensions": "101, 102 ,103",
				"ai.gemini.temperature": 1.1,
				"ai.gemini.topP": 0.8,
				"ai.gemini.maxOutputTokens": 1200,
				"ai.gemini.languageCode": "ru-RU",
				"ai.gemini.vadStartSensitivity": "START_SENSITIVITY_LOW",
				"ai.gemini.vadEndSensitivity": "END_SENSITIVITY_HIGH",
				"ai.gemini.vadPrefixPaddingMs": 120,
				"ai.gemini.vadSilenceDurationMs": 450,
			})
		);

		expect(config.enabled).toBe(false);
		expect(config.provider).toBe("gemini");
		expect(config.language).toBe("ru");
		expect(config.dialect).toBe("xorazm");
		// The label says what is HEARD, not what is spoken: the agent understands
		// every sheva and always answers in standard Uzbek, so a label reading
		// "Xorazm shevasi" would promise the behaviour that was removed.
		expect(config.dialectLabel).toBe("Ko'proq Xorazm shevasi eshitiladi");
		expect(config.geminiVoice).toBe("Sulafat");
		expect(config.geminiModel).toBe("gemini-3.1-flash-live-preview");
		expect(config.openaiVoice).toBe("cedar");
		expect(config.openaiModel).toBe("gpt-realtime");
		expect(config.transcribeModel).toBe("whisper-1");
		expect(config.analysisModel).toBe("gpt-4o-mini");
		expect(config.maxCallSeconds).toBe(300);
		expect(config.silenceHangupMs).toBe(9000);
		expect(config.greetingDelayMs).toBe(250);
		expect(config.agentExtension).toBe("900");
		// Whitespace around a comma is a typing habit, not a different extension.
		expect(config.transferExtensions).toEqual(["101", "102", "103"]);
		expect(config.gemini).toEqual({
			temperature: 1.1,
			topP: 0.8,
			maxOutputTokens: 1200,
			languageCode: "ru-RU",
			vadStartSensitivity: "START_SENSITIVITY_LOW",
			vadEndSensitivity: "END_SENSITIVITY_HIGH",
			vadPrefixPaddingMs: 120,
			vadSilenceDurationMs: 450,
		});
	});

	test("an empty transfer pool resolves to no targets, not to one empty string", () => {
		const config = resolveAiRuntimeConfig(values({ "ai.transferExtensions": "" }));

		expect(config.transferExtensions).toEqual([]);
		expect(splitSettingList(",  ,")).toEqual([]);
	});
});

// ===========================================
// Validation
// ===========================================

describe("model names are refused when the model cannot serve the endpoint", () => {
	test("the Gemini voice model must be a live model", () => {
		expect(accepted("ai.gemini.model", "gemini-3.1-flash-live-preview")).toBe(
			"gemini-3.1-flash-live-preview"
		);
		expect(refusal("ai.gemini.model", "gemini-2.5-flash")).toContain("live");
	});

	test("the OpenAI voice model must be a realtime model", () => {
		expect(accepted("ai.openai.model", "gpt-realtime")).toBe("gpt-realtime");
		expect(refusal("ai.openai.model", "gpt-4o-mini")).toContain("realtime");
	});

	test("the transcription model must be a transcription model", () => {
		expect(accepted("ai.transcribeModel", "gpt-4o-transcribe")).toBe("gpt-4o-transcribe");
		expect(accepted("ai.transcribeModel", "whisper-1")).toBe("whisper-1");
		expect(refusal("ai.transcribeModel", "gpt-4o-mini")).toContain("transcribe");
	});

	test("the analysis model must be a plain chat model", () => {
		expect(accepted("ai.analysisModel", "gpt-4o-mini")).toBe("gpt-4o-mini");
		expect(refusal("ai.analysisModel", "gpt-realtime")).toContain("chat");
		expect(refusal("ai.analysisModel", "gemini-2.0-flash-live-001")).toContain("chat");
		expect(refusal("ai.analysisModel", "gpt-4o-transcribe")).toContain("chat");
	});

	test("a model name that is not a model id at all is refused", () => {
		expect(refusal("ai.analysisModel", "GPT 4o Mini")).not.toBeNull();
		expect(refusal("ai.analysisModel", "x")).not.toBeNull();
	});
});

describe("extensions are refused when the dialler could not use them", () => {
	test("the agent extension is a short number", () => {
		expect(accepted("ai.agentExtension", "900")).toBe("900");
		expect(refusal("ai.agentExtension", "9o0")).toContain("raqam");
		expect(refusal("ai.agentExtension", "9")).not.toBeNull();
	});

	test("the transfer pool is a comma-separated list of numbers", () => {
		expect(accepted("ai.transferExtensions", "101,102")).toBe("101,102");
		// Empty is a real configuration: transfer.ts then uses sip_extensions.
		expect(accepted("ai.transferExtensions", "")).toBe("");
		expect(refusal("ai.transferExtensions", "101, operator")).toContain("vergul");
		expect(refusal("ai.transferExtensions", "101,101")).toContain("takrorlangan");
	});
});

describe("closed lists are refused rather than silently ignored", () => {
	test("the provider is one of two, in any case", () => {
		expect(accepted("ai.provider", " Gemini ")).toBe("gemini");
		expect(refusal("ai.provider", "anthropic")).toContain("openai");
	});

	test("the dialect must be one the prompt builder knows", () => {
		for (const dialect of AI_DIALECTS) {
			expect(accepted("ai.dialect", dialect)).toBe(dialect);
		}

		expect(refusal("ai.dialect", "xorezmskiy")).toContain("sheva");
	});

	test("the VAD sensitivities are Google's own constants", () => {
		expect(accepted("ai.gemini.vadStartSensitivity", "start_sensitivity_low")).toBe(
			"START_SENSITIVITY_LOW"
		);
		expect(accepted("ai.gemini.vadEndSensitivity", "END_SENSITIVITY_HIGH")).toBe(
			"END_SENSITIVITY_HIGH"
		);
		// A start value in the end field is a real mistake: Google rejects the frame.
		expect(refusal("ai.gemini.vadEndSensitivity", "START_SENSITIVITY_LOW")).not.toBeNull();
	});

	test("a voice name keeps its capitals, because Gemini's voices have them", () => {
		expect(accepted("ai.gemini.voice", "Callirrhoe")).toBe("Callirrhoe");
		expect(refusal("ai.gemini.voice", "ovoz 1")).not.toBeNull();
	});
});

describe("numeric limits", () => {
	test("out-of-range values are refused with the bound in the message", () => {
		expect(refusal("ai.maxCallSeconds", 10)).toContain("30");
		expect(refusal("ai.silenceHangupMs", 100)).toContain("1000");
		expect(refusal("ai.gemini.temperature", 2.5)).toContain("2");
		expect(refusal("ai.gemini.topP", 1.5)).toContain("1");
		expect(refusal("ai.gemini.vadSilenceDurationMs", 1.5)).toContain("Butun");
	});

	test("zero means «do not send the field» and stays legal", () => {
		expect(accepted("ai.gemini.maxOutputTokens", 0)).toBe(0);
		expect(accepted("ai.greetingDelayMs", 0)).toBe(0);
	});

	test("the speech language code is either empty or carries a region", () => {
		expect(accepted("ai.gemini.languageCode", "uz-UZ")).toBe("uz-UZ");
		expect(accepted("ai.gemini.languageCode", "")).toBe("");
		expect(refusal("ai.gemini.languageCode", "uz")).toContain("uz-UZ");
	});
});

describe("the registry entries themselves", () => {
	test("every ai setting carries an Uzbek label and description", () => {
		for (const key of getSettingKeysByCategory("ai")) {
			const definition = SETTING_DEFINITIONS[key];

			expect(definition.label.length).toBeGreaterThan(0);
			expect(definition.description.length).toBeGreaterThan(20);
		}
	});

	test("no ai setting is a secret, so the page may show every value", () => {
		for (const key of getSettingKeysByCategory("ai")) {
			expect(SETTINGS_REGISTRY[key as keyof typeof SETTINGS_REGISTRY].type).not.toBe("secret");
		}
	});
});
