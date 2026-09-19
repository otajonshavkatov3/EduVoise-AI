import dayjs from "dayjs";
import type { AiSessionStatus, ConfigField, ConfigSource, TranscriptRole } from "../types";

export const aiSessionStatusConfig: Record<AiSessionStatus, { label: string; color: string }> = {
	initializing: { label: "Ishga tushmoqda", color: "blue" },
	active: { label: "Faol", color: "green" },
	transferring: { label: "Uzatilmoqda", color: "orange" },
	completed: { label: "Yakunlandi", color: "cyan" },
	failed: { label: "Xatolik", color: "red" },
};

export const configSourceLabels: Record<ConfigSource, string> = {
	env: "Env fayli",
	override: "Shu sahifada saqlangan",
	profile: "Biznes profilidan",
};

/** Manba yorlig'ining rangi — «env» neytral, o'zgartirilgani ko'zga tashlanadi. */
export const configSourceColors: Record<ConfigSource, string> = {
	env: "default",
	override: "gold",
	profile: "blue",
};

export const configFieldLabels: Record<ConfigField, string> = {
	enabled: "Yoqilgan",
	provider: "Provayder",
	language: "Suhbat tili",
	// AI shevada GAPIRMAYDI — uni faqat tushunadi. Yorliq shu ma'noni beradi,
	// aks holda saqlash xabari («Saqlandi: Sheva») eski va'dani takrorlaydi.
	dialect: "Tushuniladigan sheva",
	voice: "Ovoz",
	model: "Ovozli suhbat modeli",
	analysisModel: "Tahlil modeli",
	transcribeModel: "Transkripsiya modeli",
	maxCallSeconds: "Qo'ng'iroq chegarasi",
	silenceHangupMs: "Jimlikdan keyin uzish",
	greetingDelayMs: "Salomlashishdan oldingi pauza",
	agentExtension: "AI ichki raqami",
	transferExtensions: "Uzatish raqamlari",
	geminiTemperature: "Temperatura",
	geminiTopP: "topP",
	geminiMaxOutputTokens: "Javobdagi eng ko'p token",
	geminiLanguageCode: "Ovoz tili kodi",
	geminiVadStartSensitivity: "Gap boshlanishini sezish",
	geminiVadEndSensitivity: "Gap tugaganini sezish",
	geminiVadPrefixPaddingMs: "Nutq boshidagi zaxira",
	geminiVadSilenceDurationMs: "Javobdan oldingi jimlik",
	audioPresenceDb: "Ovoz tiniqligi",
	audioOutputGainDb: "Chiquvchi ovoz balandligi",
};

/**
 * O'lchangan telefon tiniqligining rangi va tartibi.
 *
 * Kalit — backend qaytargan tayyor ibora (phoneClarity), chunki chegaralar
 * (-8 va -12 dB) o'sha yerda, o'lchov xatosiga qarab tanlangan: bu yerda ularni
 * takrorlash ikkita bir-biriga zid haqiqat yaratardi. Noma'lum ibora kelsa
 * neytral ko'rinadi.
 */
export const phoneClarityTones: Record<string, { color: string; text: string }> = {
	"Telefonda tiniq": { color: "green", text: "text-emerald-600" },
	"Telefonda o'rtacha": { color: "gold", text: "text-amber-600" },
	"Telefonda bo'g'iq": { color: "red", text: "text-rose-600" },
	"O'lchanmagan": { color: "default", text: "text-slate-400" },
};

export function phoneClarityTone(label: string): { color: string; text: string } {
	return phoneClarityTones[label] ?? { color: "default", text: "text-slate-400" };
}

/** Backend'dagi provayder kalitining o'qiladigan nomi (config.providerKind). */
export const providerKindLabels: Record<string, string> = {
	gemini: "Google Gemini Live",
	openai: "OpenAI Realtime",
};

/** VAD sezgirligi — ENUM nomi emas, oqibati yoziladi. */
export const vadStartLabels: Record<string, string> = {
	START_SENSITIVITY_HIGH: "Yuqori — mijoz gapira boshlashi bilan AI jim bo'ladi",
	START_SENSITIVITY_LOW: "Past — faqat aniq nutqda jim bo'ladi (shovqinli liniya uchun)",
};

export const vadEndLabels: Record<string, string> = {
	END_SENSITIVITY_HIGH: "Yuqori — tezroq javob beradi, gapni kesib qolishi mumkin",
	END_SENSITIVITY_LOW: "Past — o'ylab turgan mijozning gapini kutadi (sekinroq javob)",
};

export const transcriptRoleConfig: Record<TranscriptRole, { label: string; short: string }> = {
	caller: { label: "Mijoz", short: "M" },
	agent: { label: "AI operator", short: "AI" },
	system: { label: "Tizim", short: "T" },
};

/** Backend'dagi til kodini o'qiladigan nomga aylantiradi. */
export function languageLabel(code: string): string {
	const known: Record<string, string> = {
		uz: "O'zbek",
		ru: "Rus",
		en: "Ingliz",
	};
	return known[code] ?? code;
}

export function providerLabel(provider: string): string {
	if (provider === "openai-realtime") {
		return "OpenAI Realtime";
	}
	// Hozirda aynan shu provayder qo'ng'iroqlarga javob beradi; sharti bo'lmagani
	// uchun jadvallarda xom "gemini-live" satri chiqib turardi.
	if (provider === "gemini-live") {
		return "Gemini Live";
	}
	if (provider === "fallback-ivr") {
		return "Zaxira IVR";
	}
	return provider;
}

/** durationMs -> "3 daq 12 s". */
export function formatDurationMs(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms <= 0) {
		return "—";
	}
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) {
		return `${seconds} s`;
	}
	return `${minutes} daq ${seconds} s`;
}

export function formatAudioMs(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms <= 0) {
		return "0 s";
	}
	return `${(ms / 1000).toFixed(1)} s`;
}

export function formatDateTime(iso: string | null): string {
	if (!iso) {
		return "—";
	}
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return "—";
	}
	// The same DD.MM.YYYY the cost pages and the rest of the app use; the ISO-ish
	// uz-UZ default read as a different product on a page reached from those tables.
	// Seconds stay - the transcript column needs them.
	return dayjs(parsed).format("DD.MM.YYYY HH:mm:ss");
}

export function formatClock(iso: string): string {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return "--:--:--";
	}
	return parsed.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** Kontakt ismini yig'adi, bo'lmasa null. */
export function contactName(firstName: string | null, lastName: string | null): string | null {
	const joined = [firstName, lastName].filter(Boolean).join(" ").trim();
	return joined.length > 0 ? joined : null;
}
