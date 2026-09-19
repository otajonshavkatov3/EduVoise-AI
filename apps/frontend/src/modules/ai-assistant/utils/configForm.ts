import type { AiConfig, AiConfigPatch, ConfigField } from "../types";

/**
 * «Holat va sozlamalar» shaklining holati.
 *
 * Bitta tekis obyekt: har bir maydon backend qabul qiladigan bitta qiymatga
 * to'g'ri keladi, shuning uchun patch ham, dirty tekshiruvi ham bitta jadval
 * bo'yicha ishlaydi va yangi maydon qo'shilganda uchtasini emas, bittasini
 * yangilash kifoya.
 */
export interface AiConfigFormValues {
	enabled: boolean;
	provider: string;
	language: string;
	dialect: string;
	agentExtension: string;
	voice: string;
	model: string;
	analysisModel: string;
	transcribeModel: string;
	maxCallSeconds: number;
	silenceHangupMs: number;
	greetingDelayMs: number;
	transferExtensions: string[];
	geminiTemperature: number;
	geminiTopP: number;
	geminiMaxOutputTokens: number;
	geminiLanguageCode: string;
	geminiVadStartSensitivity: string;
	geminiVadEndSensitivity: string;
	geminiVadPrefixPaddingMs: number;
	geminiVadSilenceDurationMs: number;
	audioPresenceDb: number;
	audioOutputGainDb: number;
}

/**
 * Chegaralar backend registridan (lib/settings/registry.ts) ko'chirilgan.
 *
 * Maqsad — serverni takrorlash emas: server baribir tekshiradi va oxirgi so'z
 * o'shanda. Bu yerda ular slayder qadamlari va InputNumber chegaralari uchun
 * kerak, ya'ni foydalanuvchi umuman qabul qilinmaydigan qiymatni terib,
 * saqlash tugmasini bosib, keyin xato olishi shart emas.
 */
export const CONFIG_LIMITS = {
	temperature: { min: 0, max: 2, step: 0.05 },
	topP: { min: 0, max: 1, step: 0.01 },
	maxOutputTokens: { min: 0, max: 32_768, step: 64 },
	maxCallSeconds: { min: 30, max: 7200, step: 30 },
	silenceHangupMs: { min: 1000, max: 300_000, step: 1000 },
	greetingDelayMs: { min: 0, max: 10_000, step: 50 },
	vadPrefixPaddingMs: { min: 0, max: 5000, step: 20 },
	vadSilenceDurationMs: { min: 50, max: 10_000, step: 20 },
	// Registrdagi decimal(0, 12) bilan bir xil. Yuqori chegara o'zboshimchalik
	// emas: kodekdagi cheklagich aynan shu ikki qiymatning eng kattasida ham
	// ovoz buzilmasligini kafolatlaydi.
	presenceDb: { min: 0, max: 12, step: 0.5 },
	outputGainDb: { min: 0, max: 12, step: 0.5 },
} as const;

/** O'lchovga asoslangan tavsiya — «tavsiya etilgan» yorlig'i shu qiymatda chiqadi. */
export const RECOMMENDED_AUDIO = { presenceDb: 6, outputGainDb: 3 } as const;

export const MAX_TRANSFER_EXTENSIONS = 20;

export function toFormValues(config: AiConfig): AiConfigFormValues {
	return {
		enabled: config.enabled,
		provider: config.providerKind,
		language: config.language,
		dialect: config.dialect,
		agentExtension: config.agentExtension,
		voice: config.voice,
		model: config.model,
		analysisModel: config.analysisModel,
		transcribeModel: config.transcribeModel,
		maxCallSeconds: config.maxCallSeconds,
		silenceHangupMs: config.silenceHangupMs,
		greetingDelayMs: config.greetingDelayMs,
		transferExtensions: [...config.transferExtensions],
		geminiTemperature: config.gemini.temperature,
		geminiTopP: config.gemini.topP,
		geminiMaxOutputTokens: config.gemini.maxOutputTokens,
		geminiLanguageCode: config.gemini.languageCode,
		geminiVadStartSensitivity: config.gemini.vadStartSensitivity,
		geminiVadEndSensitivity: config.gemini.vadEndSensitivity,
		geminiVadPrefixPaddingMs: config.gemini.vadPrefixPaddingMs,
		geminiVadSilenceDurationMs: config.gemini.vadSilenceDurationMs,
		audioPresenceDb: config.audio.presenceDb,
		audioOutputGainDb: config.audio.outputGainDb,
	};
}

type GeminiPatch = NonNullable<AiConfigPatch["gemini"]>;
type AudioPatch = NonNullable<AiConfigPatch["audio"]>;

interface FieldSpec {
	/** Shakldagi qiymat bazadagidan farq qiladimi. */
	differs: (baseline: AiConfigFormValues, values: AiConfigFormValues) => boolean;
	/**
	 * Shu maydonni PATCH ga qo'shish.
	 *
	 * Backend PATCH'ida ikkita ichma-ich guruh bor — `gemini` (model sozlamalari)
	 * va `audio` (telefon liniyasiga ishlov) — shuning uchun ikkalasi ham tayyor
	 * obyekt sifatida beriladi: har bir maydon baribir bitta satr bo'lib qoladi,
	 * bo'sh guruh esa buildPatch'da tashlab yuboriladi.
	 */
	apply: (
		target: AiConfigPatch,
		gemini: GeminiPatch,
		values: AiConfigFormValues,
		audio: AudioPatch
	) => void;
}

/** Ro'yxatlar mazmuni bo'yicha solishtiriladi — tartib ham ahamiyatli. */
function sameList(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Ko'pchilik maydon uchun: oddiy tenglik va bitta o'zlashtirish. */
function plain<K extends keyof AiConfigFormValues>(key: K, apply: FieldSpec["apply"]): FieldSpec {
	return { differs: (baseline, values) => baseline[key] !== values[key], apply };
}

/**
 * Har bir maydon — bitta satr.
 *
 * `Record<ConfigField, ...>` bo'lgani uchun yangi maydonni qo'shishni unutish
 * kompilyatsiya xatosi bo'ladi, ya'ni «shaklda bor, lekin hech qachon
 * yuborilmaydigan» boshqaruv paydo bo'lolmaydi — bu sahifa aynan shundan
 * qutulish uchun qayta yozilgan.
 */
const FIELD_SPECS: Record<ConfigField, FieldSpec> = {
	enabled: plain("enabled", (patch, _gemini, values) => {
		patch.enabled = values.enabled;
	}),
	provider: plain("provider", (patch, _gemini, values) => {
		patch.provider = values.provider;
	}),
	language: plain("language", (patch, _gemini, values) => {
		patch.language = values.language;
	}),
	dialect: plain("dialect", (patch, _gemini, values) => {
		patch.dialect = values.dialect;
	}),
	voice: plain("voice", (patch, _gemini, values) => {
		patch.voice = values.voice;
	}),
	model: plain("model", (patch, _gemini, values) => {
		patch.model = values.model.trim();
	}),
	analysisModel: plain("analysisModel", (patch, _gemini, values) => {
		patch.analysisModel = values.analysisModel.trim();
	}),
	transcribeModel: plain("transcribeModel", (patch, _gemini, values) => {
		patch.transcribeModel = values.transcribeModel.trim();
	}),
	maxCallSeconds: plain("maxCallSeconds", (patch, _gemini, values) => {
		patch.maxCallSeconds = values.maxCallSeconds;
	}),
	silenceHangupMs: plain("silenceHangupMs", (patch, _gemini, values) => {
		patch.silenceHangupMs = values.silenceHangupMs;
	}),
	greetingDelayMs: plain("greetingDelayMs", (patch, _gemini, values) => {
		patch.greetingDelayMs = values.greetingDelayMs;
	}),
	agentExtension: plain("agentExtension", (patch, _gemini, values) => {
		patch.agentExtension = values.agentExtension.trim();
	}),
	transferExtensions: {
		differs: (baseline, values) =>
			!sameList(baseline.transferExtensions, values.transferExtensions),
		apply: (patch, _gemini, values) => {
			patch.transferExtensions = values.transferExtensions;
		},
	},
	geminiTemperature: plain("geminiTemperature", (_patch, gemini, values) => {
		gemini.temperature = values.geminiTemperature;
	}),
	geminiTopP: plain("geminiTopP", (_patch, gemini, values) => {
		gemini.topP = values.geminiTopP;
	}),
	geminiMaxOutputTokens: plain("geminiMaxOutputTokens", (_patch, gemini, values) => {
		gemini.maxOutputTokens = values.geminiMaxOutputTokens;
	}),
	geminiLanguageCode: plain("geminiLanguageCode", (_patch, gemini, values) => {
		gemini.languageCode = values.geminiLanguageCode.trim();
	}),
	geminiVadStartSensitivity: plain("geminiVadStartSensitivity", (_patch, gemini, values) => {
		gemini.vadStartSensitivity = values.geminiVadStartSensitivity;
	}),
	geminiVadEndSensitivity: plain("geminiVadEndSensitivity", (_patch, gemini, values) => {
		gemini.vadEndSensitivity = values.geminiVadEndSensitivity;
	}),
	geminiVadPrefixPaddingMs: plain("geminiVadPrefixPaddingMs", (_patch, gemini, values) => {
		gemini.vadPrefixPaddingMs = values.geminiVadPrefixPaddingMs;
	}),
	geminiVadSilenceDurationMs: plain("geminiVadSilenceDurationMs", (_patch, gemini, values) => {
		gemini.vadSilenceDurationMs = values.geminiVadSilenceDurationMs;
	}),
	audioPresenceDb: plain("audioPresenceDb", (_patch, _gemini, values, audio) => {
		audio.presenceDb = values.audioPresenceDb;
	}),
	audioOutputGainDb: plain("audioOutputGainDb", (_patch, _gemini, values, audio) => {
		audio.outputGainDb = values.audioOutputGainDb;
	}),
};

const ALL_FIELDS = Object.keys(FIELD_SPECS) as ConfigField[];

/** Shakldagi qaysi maydonlar bazadan farq qiladi. Patch ham, sanoq ham shundan. */
export function changedFields(
	baseline: AiConfigFormValues,
	values: AiConfigFormValues
): ConfigField[] {
	return ALL_FIELDS.filter((field) => FIELD_SPECS[field].differs(baseline, values));
}

/**
 * Faqat o'zgargan maydonlardan iborat PATCH.
 *
 * Tegilmagan maydon yuborilmaydi: PATCH yuborilgan har bir qiymatni yozadi,
 * ya'ni to'liq obyekt yuborilsa siz ochmagan bo'limlar ham «o'zgartirilgan»
 * bo'lib qolib, .env qatlamidan uzilib ketardi.
 */
export function buildPatch(
	baseline: AiConfigFormValues,
	values: AiConfigFormValues
): AiConfigPatch {
	const patch: AiConfigPatch = {};
	const gemini: GeminiPatch = {};
	const audio: AudioPatch = {};

	for (const field of changedFields(baseline, values)) {
		FIELD_SPECS[field].apply(patch, gemini, values, audio);
	}

	if (Object.keys(gemini).length > 0) {
		patch.gemini = gemini;
	}

	if (Object.keys(audio).length > 0) {
		patch.audio = audio;
	}

	return patch;
}

export type ConfigFormErrors = Partial<Record<ConfigField, string>>;

function outOfRange(value: number, limit: { min: number; max: number }): boolean {
	return !Number.isFinite(value) || value < limit.min || value > limit.max;
}

/** Til, ichki raqam va uzatish ro'yxati — provayderga bog'liq bo'lmagan qismi. */
function validateIdentity(values: AiConfigFormValues, errors: ConfigFormErrors): void {
	if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(values.language)) {
		errors.language = "Til kodi «uz» yoki «uz-UZ» ko'rinishida bo'lsin";
	}

	if (!/^\d{2,6}$/.test(values.agentExtension.trim())) {
		errors.agentExtension = "Ichki raqam 2–6 xonali son bo'lishi kerak, masalan 900";
	}

	if (values.voice.trim().length === 0) {
		errors.voice = "Ovoz tanlanmagan";
	}

	if (values.transferExtensions.some((item) => !/^\d{2,6}$/.test(item))) {
		errors.transferExtensions = "Har bir ichki raqam 2–6 xonali son bo'lishi kerak";
	} else if (new Set(values.transferExtensions).size !== values.transferExtensions.length) {
		errors.transferExtensions = "Ro'yxatda takrorlangan raqam bor";
	} else if (values.transferExtensions.length > MAX_TRANSFER_EXTENSIONS) {
		errors.transferExtensions = `Ko'pi bilan ${MAX_TRANSFER_EXTENSIONS} ta raqam`;
	}
}

/** Model nomlari: har bir tekshiruv jimgina ishlamay qoladigan holatni to'sadi. */
function validateModels(values: AiConfigFormValues, errors: ConfigFormErrors): void {
	const model = values.model.trim();

	if (model.length === 0) {
		errors.model = "Model nomi bo'sh bo'lmasin";
	} else if (values.provider === "gemini" && !model.includes("live")) {
		errors.model =
			"Gemini modeli nomida «live» bo'lishi shart, masalan gemini-3.1-flash-live-preview";
	} else if (values.provider === "openai" && !model.includes("realtime")) {
		errors.model = "OpenAI modeli nomida «realtime» bo'lishi shart, masalan gpt-realtime";
	}

	const analysis = values.analysisModel.trim();
	const forbidden = ["realtime", "live", "transcribe", "whisper", "embedding", "tts"];

	if (analysis.length === 0) {
		errors.analysisModel = "Model nomi bo'sh bo'lmasin";
	} else if (forbidden.some((word) => analysis.includes(word))) {
		errors.analysisModel = "Tahlil uchun oddiy matnli (chat) model kerak, masalan gpt-4o-mini";
	}

	const transcribe = values.transcribeModel.trim();

	if (!(transcribe.includes("transcribe") || transcribe.includes("whisper"))) {
		errors.transcribeModel = "Nomida «transcribe» yoki «whisper» bo'lishi shart";
	}
}

/** Sonli chegaralar — registrdagi min/max bilan bir xil. */
function validateNumbers(values: AiConfigFormValues, errors: ConfigFormErrors): void {
	if (outOfRange(values.maxCallSeconds, CONFIG_LIMITS.maxCallSeconds)) {
		errors.maxCallSeconds = "30 dan 7200 sekundgacha";
	}

	if (outOfRange(values.silenceHangupMs, CONFIG_LIMITS.silenceHangupMs)) {
		errors.silenceHangupMs = "1000 dan 300000 ms gacha";
	}

	if (outOfRange(values.greetingDelayMs, CONFIG_LIMITS.greetingDelayMs)) {
		errors.greetingDelayMs = "0 dan 10000 ms gacha";
	}

	if (outOfRange(values.geminiTemperature, CONFIG_LIMITS.temperature)) {
		errors.geminiTemperature = "0 dan 2 gacha";
	}

	if (outOfRange(values.geminiTopP, CONFIG_LIMITS.topP)) {
		errors.geminiTopP = "0 dan 1 gacha";
	}

	if (outOfRange(values.geminiMaxOutputTokens, CONFIG_LIMITS.maxOutputTokens)) {
		errors.geminiMaxOutputTokens = "0 dan 32768 gacha";
	}

	if (outOfRange(values.geminiVadPrefixPaddingMs, CONFIG_LIMITS.vadPrefixPaddingMs)) {
		errors.geminiVadPrefixPaddingMs = "0 dan 5000 ms gacha";
	}

	if (outOfRange(values.geminiVadSilenceDurationMs, CONFIG_LIMITS.vadSilenceDurationMs)) {
		errors.geminiVadSilenceDurationMs = "50 dan 10000 ms gacha";
	}

	if (outOfRange(values.audioPresenceDb, CONFIG_LIMITS.presenceDb)) {
		errors.audioPresenceDb = "0 dan 12 dB gacha";
	}

	if (outOfRange(values.audioOutputGainDb, CONFIG_LIMITS.outputGainDb)) {
		errors.audioOutputGainDb = "0 dan 12 dB gacha";
	}

	const languageCode = values.geminiLanguageCode.trim();

	if (languageCode.length > 0 && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})+$/.test(languageCode)) {
		errors.geminiLanguageCode = "Mintaqasi bilan yozing: uz-UZ, ru-RU";
	}
}

/**
 * Server rad etadigan qiymatlarni oldindan aytish.
 *
 * Bu tekshiruv serverning o'rnini bosmaydi — u yerda registr sxemasi va
 * provayderga bog'liq qoidalar bor va oxirgi so'z o'shanda. Bu yerdagilar
 * shunchaki sahifada darhol ko'rinadi, chunki 400 xatosini kutish o'rniga
 * maydon ostidagi qizil satr tezroq tushuntiradi.
 */
export function validateConfig(values: AiConfigFormValues): ConfigFormErrors {
	const errors: ConfigFormErrors = {};

	validateIdentity(values, errors);
	validateModels(values, errors);
	validateNumbers(values, errors);

	return errors;
}

/**
 * Saqlashdan oldingi ogohlantirishlar: qiymat qabul qilinadi, lekin oqibati bor.
 *
 * Xato emas — shuning uchun saqlashni to'smaydi. Har biri o'lchangan yoki
 * hujjatlangan xatti-harakat haqida, taxmin haqida emas.
 */
export function configWarnings(values: AiConfigFormValues, config: AiConfig): string[] {
	const warnings: string[] = [];

	if (!values.enabled) {
		warnings.push(
			"AI o'chirilgan holatda saqlanadi — kiruvchi qo'ng'iroqlar IVR zaxirasiga tushadi."
		);
	}

	if (values.geminiTemperature >= 1.4) {
		warnings.push(
			"Temperatura 1.4 dan yuqori: javoblar jonli, lekin bilim bazasidan chetga chiqish ehtimoli ortadi."
		);
	}

	if (values.geminiMaxOutputTokens > 0 && values.geminiMaxOutputTokens < 256) {
		warnings.push(
			"256 dan kichik token chegarasi javobni gap o'rtasida kesadi — provayder uni 256 ga ko'taradi."
		);
	}

	if (values.geminiVadSilenceDurationMs < 300) {
		warnings.push(
			"Javobdan oldingi jimlik 300 ms dan kam: AI mijozning o'ylab turgan pauzasini «gap tugadi» deb qabul qilib, gapini kesishi mumkin."
		);
	}

	if (values.geminiVadSilenceDurationMs > 1200) {
		warnings.push(
			"Javobdan oldingi jimlik 1.2 sekunddan ko'p: suhbat sekinlashadi, mijoz «eshitmadi» deb o'ylashi mumkin."
		);
	}

	if (values.geminiVadStartSensitivity === "START_SENSITIVITY_HIGH") {
		warnings.push(
			"Gap boshlanishini sezish «yuqori»: 8 kHz telefon liniyasida mijoz go'shagi AI ning o'z ovozini qaytaradi va bu gohida «mijoz gapirdi» deb qabul qilinishi mumkin."
		);
	}

	if (values.audioPresenceDb === 0) {
		warnings.push(
			"Tiniqlik filtri o'chirilgan (0 dB): ovoz modeldan qanday chiqsa, mijoz shuni eshitadi. O'lchovda undosh tovushlar diapazoni (1200–3400 Hz) shu holatda 15–32 dB past chiqadi."
		);
	}

	// O'lchangan tafovut 12 dB — filtr qo'shadigan ~3 dB dan ancha katta, ya'ni
	// bo'g'iq ovozni tanlash filtr bilan to'liq qoplanmaydi. Shuning uchun bu
	// ogohlantirish taxmin emas, o'lchovga tayanadi.
	const chosenVoice = config.voiceCatalog.find((option) => option.name === values.voice);

	if (chosenVoice && chosenVoice.phoneClarityDb !== null && chosenVoice.phoneClarityDb < -12) {
		warnings.push(
			`«${chosenVoice.name}» telefon liniyasida eng bo'g'iq ovozlardan biri (o'lchov: ${chosenVoice.phoneClarityDb} dB). Tiniqlik filtri ~3 dB qo'shadi, ovozlar orasidagi farq esa 12 dB — tiniqroq ovoz tanlash ko'proq yordam beradi.`
		);
	}

	if (values.provider === "gemini" && !config.googleApiKeyConfigured) {
		warnings.push("GOOGLE_AI_API_KEY .env da yo'q — Gemini sessiyasi ochilmaydi.");
	}

	if (values.transferExtensions.length === 0) {
		warnings.push(
			"Uzatish ro'yxati bo'sh: AI operatorga uzatishda sip_extensions jadvalidagi yoqilgan raqamlarni ishlatadi."
		);
	}

	return warnings;
}
