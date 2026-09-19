import type { AIStatus, CallDirection, CallStatus } from "@/modules/calls/types";

// ===========================================
// Enumlar (backend: ai-assistant.schemas.ts)
// ===========================================

export type AiSessionStatus = "initializing" | "active" | "transferring" | "completed" | "failed";

export type TranscriptRole = "caller" | "agent" | "system";

/**
 * Qiymat qayerdan kelgani.
 *
 * "profile" — faol biznes profili yozuvi hal qiladi (ovoz, til va ikki chegara),
 * "override" — shu sahifada saqlangan qiymat, "env" — .env dagi (yoki koddagi)
 * boshlang'ich qiymat, ya'ni hech kim o'zgartirmagan.
 */
export type ConfigSource = "profile" | "override" | "env";

export type ConfigField =
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

/** Izoh tahrirlanmaydigan maydonga ham tegishli bo'lishi mumkin. */
export type ConfigNoteField = ConfigField | "ariApp" | "audioSocketAdvertiseHost";

// ===========================================
// GET /api/ai-assistant/status
// ===========================================

export interface AiProviderStatus {
	/** Keyingi qo'ng'iroqni oladigan provayder ("openai-realtime" / "fallback-ivr"). */
	provider: string;
	/** Realtime sessiya haqiqatan ochilishi mumkinmi. */
	available: boolean;
	/** Sababning aynan backend bergan matni — o'zgartirmasdan ko'rsatiladi. */
	detail: string;
	enabled: boolean;
	model: string;
	voice: string;
	language: string;
	apiKeyConfigured: boolean;
	agentExtension: string;
	orchestrator: {
		running: boolean;
		activeCalls: number;
	};
	checkedAt: string;
}

export interface AiStatusResponse {
	success: boolean;
	data: AiProviderStatus;
}

// ===========================================
// GET / PATCH /api/ai-assistant/config
// ===========================================

/** Bitta tanlanadigan ovoz. Provayder xarakterni e'lon qilmasa — bo'sh satr. */
export interface AiVoiceOption {
	name: string;
	/** Google'ning inglizcha ta'rifi: "Warm", "Gravelly". */
	character: string;
	/** O'sha ta'rifning o'zbekchasi. */
	description: string;
	/**
	 * Undosh tovushlar energiyasining unli tovushlarnikiga nisbati, dB.
	 *
	 * Shu deploymentda o'lchangan — provayderning va'dasi emas. Telefon liniyasi
	 * faqat 300–3400 Hz ni o'tkazadi, so'zni ajratib turadigan undoshlar esa shu
	 * oraliqning yuqorisida yotadi, shuning uchun bu son ovoz telefonda qanchalik
	 * tushunarli eshitilishini har qanday sifatdan aniqroq aytadi. Null — bu ovoz
	 * o'lchanmagan (nol emas).
	 */
	phoneClarityDb: number | null;
	/** O'sha o'lchovning tayyor o'zbekcha iborasi: «Telefonda tiniq». */
	phoneClarity: string;
}

export interface AiDialectOption {
	value: string;
	label: string;
	/** Sheva aynan qaysi so'z shakllarini o'zgartiradi. */
	description: string;
}

/** Gemini setup kadriga yuboriladigan gapirish sozlamalari. */
export interface AiGeminiSpeech {
	temperature: number;
	topP: number;
	/** 0 — maydon umuman yuborilmaydi. */
	maxOutputTokens: number;
	/** "" — maydon yuborilmaydi, model tilni o'zi tanlaydi. */
	languageCode: string;
	vadStartSensitivity: string;
	vadEndSensitivity: string;
	vadPrefixPaddingMs: number;
	vadSilenceDurationMs: number;
}

/**
 * Mijozga yetib borishdan oldin AI ovoziga qo'llanadigan ishlov.
 *
 * Modelga emas, telefon liniyasiga tegishli, shuning uchun `gemini` ichida emas.
 * Hozircha faqat Gemini oqimida ishlaydi — backend buni izohda aytadi.
 */
export interface AiOutboundAudio {
	/** 2100 Hz atrofidagi tiniqlik ko'tarmasi, dB. 0 — filtr butunlay o'chadi. */
	presenceDb: number;
	/** Filtrdan keyingi balandlik, dB. Ortida cheklagich turadi. */
	outputGainDb: number;
}

/** Maydon nimani O'ZGARTIRMAYDI — backend yozgan matn, o'zgartirilmasdan ko'rsatiladi. */
export interface AiConfigNote {
	field: ConfigNoteField;
	note: string;
}

export interface AiConfig {
	enabled: boolean;
	language: string;
	voice: string;
	dialect: string;
	/** Keyingi qo'ng'iroqni oladigan provayder ("gemini-live" / "fallback-ivr"). */
	provider: string;
	/** Sozlangan provayder turi ("gemini" / "openai"), ishlay olmasa ham. */
	providerKind: string;
	model: string;
	analysisModel: string;
	transcribeModel: string;
	agentExtension: string;
	transferExtensions: string[];
	maxCallSeconds: number;
	silenceHangupMs: number;
	greetingDelayMs: number;
	gemini: AiGeminiSpeech;
	audio: AiOutboundAudio;
	apiKeyConfigured: boolean;
	googleApiKeyConfigured: boolean;
	audioSocketAdvertiseHost: string;
	ariApp: string;
	knownVoices: string[];
	voiceCatalog: AiVoiceOption[];
	options: {
		providers: string[];
		dialects: AiDialectOption[];
		vadStartSensitivities: string[];
		vadEndSensitivities: string[];
	};
	overrides: Record<ConfigField, string | number | boolean | null>;
	sources: Record<ConfigField, ConfigSource>;
	/** Backend restartisiz kuchga kirmaydigan maydonlar. Odatda bo'sh. */
	restartRequiredFor: ConfigField[];
	notes: AiConfigNote[];
}

export interface AiConfigResponse {
	success: boolean;
	data: AiConfig;
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

// ===========================================
// POST /api/ai-assistant/voice-preview
// ===========================================

export interface AiVoicePreviewRequest {
	voice: string;
	/** Berilmasa backend biznes profilining salomlashish matnini o'qiydi. */
	text?: string;
}

export interface AiVoicePreview {
	voice: string;
	text: string;
	/** Namuna modeli — jonli suhbat modeli EMAS. */
	model: string;
	mimeType: string;
	audioBase64: string;
	durationMs: number;
	/** True — keshdan olindi, Google'ga so'rov ketmadi. */
	cached: boolean;
}

export interface AiVoicePreviewResponse {
	success: boolean;
	data: AiVoicePreview;
}

export interface AiConfigUpdateResponse {
	success: boolean;
	data: {
		config: AiConfig;
		/** Amaldagi qiymati haqiqatan o'zgargan maydonlar. */
		changed: ConfigField[];
	};
}

// ===========================================
// GET /api/ai-assistant/sessions
// ===========================================

export interface AiSessionCall {
	id: string;
	direction: CallDirection;
	callerNumber: string;
	calleeExtension: string | null;
	status: CallStatus;
	aiStatus: AIStatus | null;
	duration: number | null;
	ticketId: string | null;
	operatorId: string | null;
	startedAt: string;
	endedAt: string | null;
}

export interface AiSessionContact {
	id: string;
	phoneNumber: string;
	firstName: string | null;
	lastName: string | null;
}

export interface AiSessionTranscriptLine {
	id: string;
	role: TranscriptRole;
	content: string;
	startMs: number | null;
	endMs: number | null;
	isFinal: boolean;
	confidence: number | null;
	createdAt: string;
}

export interface AiSession {
	id: string;
	callId: string;
	channelId: string | null;
	provider: string;
	model: string | null;
	voice: string | null;
	language: string | null;
	status: AiSessionStatus;
	interruptions: number;
	inputAudioMs: number;
	outputAudioMs: number;
	promptTokens: number | null;
	completionTokens: number | null;
	/** Null — provayder bu sonni bermagan. Nol emas. */
	cachedPromptTokens: number | null;
	inputTextTokens: number | null;
	inputAudioTokens: number | null;
	outputTextTokens: number | null;
	outputAudioTokens: number | null;
	responseTurns: number | null;
	transcribeAudioTokens: number | null;
	transcribeTextTokens: number | null;
	transcribeModel: string | null;
	errorMessage: string | null;
	startedAt: string;
	endedAt: string | null;
	durationMs: number | null;
	createdAt: string;
	transcriptCount: number;
	call: AiSessionCall;
	contact: AiSessionContact | null;
}

/**
 * Shu sessiyaning narxi, o'qish paytida joriy narxlar bo'yicha hisoblanadi.
 * Har bir null — "hisoblab bo'lmadi", 0 emas.
 */
export interface AiSessionCost {
	voiceCostUsd: number | null;
	transcriptionCostUsd: number | null;
	/** Gemini uchun true: alohida transkripsiya to'lovi yo'q, narxi 0 emas. */
	transcriptionNotApplicable: boolean;
	analysisCostUsd: number | null;
	totalCostUsd: number | null;
	costPerMinuteUsd: number | null;
	totalCostUzs: number | null;
	estimated: boolean;
	unpricedReason: string | null;
	cachedSharePct: number | null;
	/**
	 * Token taqsimoti. Null — provayder bu sonni bermagan (masalan eski sessiya).
	 * Nol emas: "kesh umuman ishlamagan" — bu boshqa va ancha qimmat hikoya, shuning
	 * uchun bu maydonlarni qo'shishdan oldin har birini tekshirish shart.
	 */
	freshPromptTokens: number | null;
	cachedPromptTokens: number | null;
	freshAudioTokens: number | null;
	freshTextTokens: number | null;
	cachedAudioTokens: number | null;
	cachedTextTokens: number | null;
	analysisBilledRuns: number;
}

export interface AiSessionDetail extends AiSession {
	metadata: Record<string, unknown> | null;
	transcript: AiSessionTranscriptLine[];
	transcriptTruncated: boolean;
	cost: AiSessionCost;
}

export interface AiSessionFilters {
	status?: AiSessionStatus;
	provider?: string;
	callId?: string;
	from?: string;
	to?: string;
	page?: number;
	limit?: number;
}

export interface AiSessionsResponse {
	success: boolean;
	data: {
		items: AiSession[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
	};
}

export interface AiSessionDetailResponse {
	success: boolean;
	data: AiSessionDetail;
}
