import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";

const aiSessionStatusEnum = z.enum([
	"initializing",
	"active",
	"transferring",
	"completed",
	"failed",
]);
const callDirectionEnum = z.enum(["inbound", "outbound"]);
const callStatusEnum = z.enum(["ringing", "answered", "missed", "abandoned", "completed"]);
const aiStatusEnum = z.enum(["pending", "processing", "completed", "failed"]);
const transcriptRoleEnum = z.enum(["caller", "agent", "system"]);
/**
 * Where an effective value comes from.
 *
 * "profile" was added when the four fields the business profile owns started
 * being reported truthfully: ovoz, til va ikki chegara profil yozuvida yashaydi.
 * "env" still covers the built-in default, because the registry makes them the
 * same value.
 */
const configSourceEnum = z.enum(["profile", "override", "env"]);

/** Every field PATCH /config accepts, in the flat form `changed` reports. */
const configFieldEnum = z.enum([
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
]);

/** A note may also describe a field that is read-only, hence the two extras. */
const configNoteFieldEnum = z.enum([
	...configFieldEnum.options,
	"ariApp",
	"audioSocketAdvertiseHost",
]);

/**
 * Per-field metadata, one entry per editable field.
 *
 * Kept as objects with a key per field rather than an array so the existing
 * clients that read `sources.language` keep working unchanged.
 */
const configFieldRecord = <T extends z.ZodTypeAny>(value: T) =>
	z.object(
		Object.fromEntries(configFieldEnum.options.map((field) => [field, value])) as Record<
			(typeof configFieldEnum.options)[number],
			T
		>
	);

/** One choosable voice. `character` / `description` are "" when the vendor publishes none. */
const AiVoiceOptionSchema = z
	.object({
		name: z.string(),
		character: z.string(),
		description: z.string(),
		/**
		 * Consonant energy against vowel energy over a spoken sentence, in dB, as
		 * measured on this account. A telephone carries only 300-3400 Hz and the
		 * consonants live in the top of that, so this predicts how clear the voice
		 * sounds on a real line better than any adjective does. Null when nobody
		 * has measured this voice - no figure is invented.
		 */
		phoneClarityDb: z.number().nullable(),
		/** The same thing as one Uzbek phrase, ready to print next to the name. */
		phoneClarity: z.string(),
	})
	.openapi("AiVoiceOption");

const GeminiSpeechSchema = z
	.object({
		/** generationConfig.temperature */
		temperature: z.number(),
		/** generationConfig.topP */
		topP: z.number(),
		/** generationConfig.maxOutputTokens; 0 means the field is not sent. */
		maxOutputTokens: z.number().int(),
		/** speechConfig.languageCode; "" means the field is not sent. */
		languageCode: z.string(),
		vadStartSensitivity: z.string(),
		vadEndSensitivity: z.string(),
		vadPrefixPaddingMs: z.number().int(),
		vadSilenceDurationMs: z.number().int(),
	})
	.openapi("AiGeminiSpeechConfig");

/**
 * What the agent's voice is put through before it reaches the caller.
 *
 * Provider-independent by design - it describes the 300-3400 Hz telephone line,
 * not the model - but only the Gemini path resamples, so a note on the field
 * says so when the active provider is the other one.
 */
const OutboundAudioSchema = z
	.object({
		/** Presence-bell lift at 2.1 kHz, in dB. 0 switches the whole chain off. */
		presenceDb: z.number(),
		/** Make-up gain after the bell, in dB; a look-ahead limiter keeps it clean. */
		outputGainDb: z.number(),
	})
	.openapi("AiOutboundAudioConfig");

// ===========================================
// Status
// ===========================================

export const AiStatusOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		/** Provider that will serve the next call ("openai-realtime" or "fallback-ivr"). */
		provider: z.string(),
		/** Whether a Realtime session can actually be opened by this account. */
		available: z.boolean(),
		/** Human-readable explanation, safe to show in the dashboard. */
		detail: z.string(),
		enabled: z.boolean(),
		model: z.string(),
		voice: z.string(),
		language: z.string(),
		/** Whether OPENAI_API_KEY is set. The key is never returned. */
		apiKeyConfigured: z.boolean(),
		agentExtension: z.string(),
		orchestrator: z.object({
			running: z.boolean(),
			activeCalls: z.number().int(),
		}),
		checkedAt: z.string().datetime(),
	}),
});

// ===========================================
// Config
// ===========================================

export const AiConfigSchema = z
	.object({
		enabled: z.boolean(),
		language: z.string(),
		voice: z.string(),
		/** Sheva slug from `options.dialects`, e.g. "xorazm". */
		dialect: z.string(),
		/** Provider that answers the next call; `voice`, `model` and `knownVoices` describe it. */
		provider: z.string(),
		/** The configured provider kind ("gemini" / "openai"), even when it cannot run. */
		providerKind: z.string(),
		model: z.string(),
		analysisModel: z.string(),
		transcribeModel: z.string(),
		agentExtension: z.string(),
		transferExtensions: z.array(z.string()),
		maxCallSeconds: z.number().int(),
		silenceHangupMs: z.number().int(),
		greetingDelayMs: z.number().int(),
		gemini: GeminiSpeechSchema,
		audio: OutboundAudioSchema,
		apiKeyConfigured: z.boolean(),
		googleApiKeyConfigured: z.boolean(),
		audioSocketAdvertiseHost: z.string(),
		ariApp: z.string(),
		/** Voices the ACTIVE provider is known to accept. Checked on write, not advisory. */
		knownVoices: z.array(z.string()),
		/** The same voices with their character, so the picker is choosable. */
		voiceCatalog: z.array(AiVoiceOptionSchema),
		/** The closed lists the form's selects are built from. */
		options: z.object({
			providers: z.array(z.string()),
			dialects: z.array(
				z.object({ value: z.string(), label: z.string(), description: z.string() })
			),
			vadStartSensitivities: z.array(z.string()),
			vadEndSensitivities: z.array(z.string()),
		}),
		/** The effective value when it is not the .env/built-in baseline, else null. */
		overrides: configFieldRecord(z.union([z.string(), z.number(), z.boolean()]).nullable()),
		sources: configFieldRecord(configSourceEnum),
		/** Fields that only reach every consumer after a backend restart. */
		restartRequiredFor: z.array(configFieldEnum),
		/** What a field does NOT do, in Uzbek. Rendered under the field. */
		notes: z.array(z.object({ field: configNoteFieldEnum, note: z.string() })),
	})
	.openapi("AiAssistantConfig");

export const AiConfigOutSchema = z.object({
	success: z.literal(true),
	data: AiConfigSchema,
});

/**
 * The patch.
 *
 * Every field is optional and only the fields present are written, so the three
 * this endpoint originally accepted (enabled, language, voice) still work exactly
 * as before. The shapes here are deliberately loose - the real validation is the
 * settings registry's own schema plus the cross-checks in ai-assistant.runtime.ts,
 * because a 422 from this layer cannot carry the Uzbek explanation of WHY a model
 * name or a voice cannot work.
 */
export const UpdateConfigBodySchema = z
	.object({
		enabled: z.boolean().optional().openapi({ example: true }),
		/** "gemini" or "openai". See options.providers in GET /config. */
		provider: z.string().max(20).optional().openapi({ example: "gemini" }),
		/** Short language code, e.g. "uz" or "ru". */
		language: z
			.string()
			.regex(/^[a-z]{2}(-[A-Za-z]{2})?$/, {
				message: "Til kodi «uz» yoki «uz-UZ» ko'rinishida bo'lishi kerak",
			})
			.optional()
			.openapi({ example: "uz" }),
		/** Sheva slug. See options.dialects in GET /config. */
		dialect: z.string().max(40).optional().openapi({ example: "xorazm" }),
		/**
		 * Voice name for the ACTIVE provider. See knownVoices in GET /config.
		 *
		 * Upper case is allowed because Gemini's voices are capitalised
		 * ("Callirrhoe"); the previous lower-case-only pattern rejected every
		 * legal value on that provider with a 422.
		 */
		voice: z
			.string()
			.regex(/^[A-Za-z][A-Za-z0-9_-]{1,49}$/, {
				message:
					"Ovoz nomi harf bilan boshlanib, faqat harf, raqam, «-» va «_» dan iborat bo'lishi kerak",
			})
			.optional()
			.openapi({ example: "Callirrhoe" }),
		/** Voice model for the ACTIVE provider. */
		model: z.string().max(80).optional().openapi({ example: "gemini-3.1-flash-live-preview" }),
		analysisModel: z.string().max(80).optional().openapi({ example: "gpt-4o-mini" }),
		transcribeModel: z.string().max(80).optional().openapi({ example: "gpt-4o-transcribe" }),
		maxCallSeconds: z.number().int().optional().openapi({ example: 900 }),
		silenceHangupMs: z.number().int().optional().openapi({ example: 20000 }),
		greetingDelayMs: z.number().int().optional().openapi({ example: 300 }),
		agentExtension: z.string().max(10).optional().openapi({ example: "900" }),
		transferExtensions: z
			.array(z.string().max(10))
			.max(20)
			.optional()
			.openapi({ example: ["101", "102"] }),
		gemini: z
			.object({
				temperature: z.number().optional(),
				topP: z.number().optional(),
				maxOutputTokens: z.number().int().optional(),
				languageCode: z.string().max(20).optional(),
				vadStartSensitivity: z.string().max(40).optional(),
				vadEndSensitivity: z.string().max(40).optional(),
				vadPrefixPaddingMs: z.number().int().optional(),
				vadSilenceDurationMs: z.number().int().optional(),
			})
			.optional(),
		/** The telephone-line chain. Not nested under `gemini`: it is not a model setting. */
		audio: z
			.object({
				presenceDb: z.number().optional().openapi({ example: 6 }),
				outputGainDb: z.number().optional().openapi({ example: 3 }),
			})
			.optional(),
	})
	.openapi("AiAssistantConfigPatch");

export const UpdateConfigOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		config: AiConfigSchema,
		changed: z.array(configFieldEnum),
	}),
});

// ===========================================
// Voice preview
// ===========================================

/**
 * Render one line in one voice so the picker can be listened to.
 *
 * The text is optional and defaults to the active profile's own greeting - the
 * line the caller really hears first - so the sample is this business's, not a
 * demo sentence.
 */
export const VoicePreviewBodySchema = z
	.object({
		voice: z
			.string()
			.regex(/^[A-Za-z][A-Za-z0-9_-]{1,49}$/, {
				message:
					"Ovoz nomi harf bilan boshlanib, faqat harf, raqam, «-» va «_» dan iborat bo'lishi kerak",
			})
			.openapi({ example: "Sulafat" }),
		text: z.string().trim().min(1).max(240).optional(),
	})
	.openapi("AiVoicePreviewRequest");

export const VoicePreviewOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		voice: z.string(),
		/** Exactly what was spoken, so the page can print it under the player. */
		text: z.string(),
		/** The TTS model, which is NOT the live conversation model. */
		model: z.string(),
		/** Always "audio/wav" - the API returns headerless PCM and the server wraps it. */
		mimeType: z.string(),
		audioBase64: z.string(),
		durationMs: z.number().int(),
		/** True when it was served from the in-memory cache, i.e. no quota was spent. */
		cached: z.boolean(),
	}),
});

// ===========================================
// Sessions
// ===========================================

export const AiSessionCallSchema = z
	.object({
		id: uuidSchema,
		direction: callDirectionEnum,
		callerNumber: z.string(),
		calleeExtension: z.string().nullable(),
		status: callStatusEnum,
		aiStatus: aiStatusEnum.nullable(),
		duration: z.number().int().nullable(),
		ticketId: uuidSchema.nullable(),
		operatorId: uuidSchema.nullable(),
		startedAt: z.string().datetime(),
		endedAt: z.string().datetime().nullable(),
	})
	.openapi("AiSessionCall");

export const AiSessionContactSchema = z
	.object({
		id: uuidSchema,
		phoneNumber: z.string(),
		firstName: z.string().nullable(),
		lastName: z.string().nullable(),
	})
	.openapi("AiSessionContact");

export const AiSessionTranscriptLineSchema = z
	.object({
		id: uuidSchema,
		role: transcriptRoleEnum,
		content: z.string(),
		startMs: z.number().int().nullable(),
		endMs: z.number().int().nullable(),
		isFinal: z.boolean(),
		confidence: z.number().int().nullable(),
		createdAt: z.string().datetime(),
	})
	.openapi("AiSessionTranscriptLine");

/** Not registered as a component: the detail response extends it. */
export const AiSessionItemSchema = z.object({
	id: uuidSchema,
	callId: uuidSchema,
	channelId: z.string().nullable(),
	provider: z.string(),
	model: z.string().nullable(),
	voice: z.string().nullable(),
	language: z.string().nullable(),
	status: aiSessionStatusEnum,
	interruptions: z.number().int(),
	inputAudioMs: z.number().int(),
	outputAudioMs: z.number().int(),
	promptTokens: z.number().int().nullable(),
	completionTokens: z.number().int().nullable(),
	// Additive: the breakdown a cost figure needs. Null means the provider never
	// reported the number, which is not the same as reporting zero.
	cachedPromptTokens: z.number().int().nullable(),
	inputTextTokens: z.number().int().nullable(),
	inputAudioTokens: z.number().int().nullable(),
	outputTextTokens: z.number().int().nullable(),
	outputAudioTokens: z.number().int().nullable(),
	responseTurns: z.number().int().nullable(),
	transcribeAudioTokens: z.number().int().nullable(),
	transcribeTextTokens: z.number().int().nullable(),
	transcribeModel: z.string().nullable(),
	errorMessage: z.string().nullable(),
	startedAt: z.string().datetime(),
	endedAt: z.string().datetime().nullable(),
	durationMs: z.number().int().nullable(),
	createdAt: z.string().datetime(),
	transcriptCount: z.number().int(),
	call: AiSessionCallSchema,
	contact: AiSessionContactSchema.nullable(),
});

export const SessionsQuerySchema = z
	.object({
		status: aiSessionStatusEnum.optional().openapi({ param: { name: "status", in: "query" } }),
		provider: z
			.string()
			.max(50)
			.optional()
			.openapi({ param: { name: "provider", in: "query" }, example: "openai-realtime" }),
		callId: uuidSchema.optional().openapi({ param: { name: "callId", in: "query" } }),
		from: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "from", in: "query" } }),
		to: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "to", in: "query" } }),
	})
	.merge(PaginationQuerySchema);

export const SessionsOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(AiSessionItemSchema),
		meta: PaginationMetaSchema,
	}),
});

/**
 * This one session's priced line items.
 *
 * Served here rather than from /ai-costs so the session page gains a cost card
 * with no second request. Every money field is nullable and null always means
 * "not known" - a session whose usage went missing must never render as 0.
 */
export const AiSessionCostSchema = z
	.object({
		voiceCostUsd: z.number().nullable(),
		transcriptionCostUsd: z.number().nullable(),
		/** Gemini transkripsiyani suhbat ichida bajaradi — alohida to'lov yo'q, 0 emas. */
		transcriptionNotApplicable: z.boolean(),
		analysisCostUsd: z.number().nullable(),
		totalCostUsd: z.number().nullable(),
		costPerMinuteUsd: z.number().nullable(),
		totalCostUzs: z.number().nullable(),
		/** Kirish narxi taqsimlangan — taxminiy. Chiqish narxi aniq. */
		estimated: z.boolean(),
		/** Narxlanmagan bo'lsa sababi, aks holda null. */
		unpricedReason: z.string().nullable(),
		cachedSharePct: z.number().nullable(),
		/**
		 * Token taqsimoti. Null — provayder bu sonni bermagan (masalan eski sessiya),
		 * ya'ni 0 emas: "kesh umuman ishlamagan" degani boshqa va ancha qimmat hikoya.
		 */
		freshPromptTokens: z.number().int().nullable(),
		cachedPromptTokens: z.number().int().nullable(),
		freshAudioTokens: z.number().int().nullable(),
		freshTextTokens: z.number().int().nullable(),
		cachedAudioTokens: z.number().int().nullable(),
		cachedTextTokens: z.number().int().nullable(),
		analysisBilledRuns: z.number().int(),
	})
	.openapi("AiSessionCost");

export const SessionOneOutSchema = z.object({
	success: z.literal(true),
	data: AiSessionItemSchema.extend({
		/** ai_sessions.metadata jsonb, written by the orchestrator. */
		metadata: z.record(z.string(), z.unknown()).nullable(),
		transcript: z.array(AiSessionTranscriptLineSchema),
		/** True when the transcript was capped by the server-side limit. */
		transcriptTruncated: z.boolean(),
		cost: AiSessionCostSchema,
	}),
});

export type UpdateConfigBody = z.infer<typeof UpdateConfigBodySchema>;
export type VoicePreviewBody = z.infer<typeof VoicePreviewBodySchema>;
export type SessionsQuery = z.infer<typeof SessionsQuerySchema>;
export type AiSessionItem = z.infer<typeof AiSessionItemSchema>;
export type AiSessionTranscriptLine = z.infer<typeof AiSessionTranscriptLineSchema>;
export type AiSessionCost = z.infer<typeof AiSessionCostSchema>;
