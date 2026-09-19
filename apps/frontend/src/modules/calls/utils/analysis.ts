import type { Sentiment } from "../types/analysis";

interface SentimentConfig {
	label: string;
	/** Ant Design Tag rangi */
	color: string;
	/** Tailwind nuqta klassi */
	dotClass: string;
}

/** Dashboard SentimentChart ranglari bilan bir xil: emerald / slate / rose. */
export const sentimentConfig: Record<Sentiment, SentimentConfig> = {
	positive: { label: "Ijobiy", color: "green", dotClass: "bg-emerald-500" },
	neutral: { label: "Neytral", color: "default", dotClass: "bg-slate-400" },
	negative: { label: "Manfiy", color: "red", dotClass: "bg-rose-500" },
};

export const SENTIMENT_OPTIONS: Array<{ value: Sentiment; label: string }> = [
	{ value: "positive", label: sentimentConfig.positive.label },
	{ value: "neutral", label: sentimentConfig.neutral.label },
	{ value: "negative", label: sentimentConfig.negative.label },
];

/**
 * Kategoriyalar backend promptidagi ro'yxat bilan bir xil (TICKET_CATEGORIES).
 * Qo'lda tuzatishda tanlash uchun taklif qilinadi, lekin boshqa qiymat ham
 * kiritish mumkin.
 */
export const CATEGORY_SUGGESTIONS = [
	"Yo'l",
	"Suv",
	"Gaz",
	"Elektr",
	"Obodonlashtirish",
	"Transport",
	"Uy-joy",
	"Tibbiyot",
	"Ta'lim",
	"Boshqa",
];

/** Ishonch darajasi (0-100) foizga. Yo'q bo'lsa null — 0 deb ko'rsatilmaydi. */
export function formatAnalysisConfidence(confidence: number | null): string | null {
	if (confidence === null || !Number.isFinite(confidence)) {
		return null;
	}
	return `${Math.round(confidence)}%`;
}

/**
 * Backend saqlagan xato matnini o'zbekcha izohga moslashtiradi.
 *
 * Izoh faqat tanilgan naqshlar uchun beriladi; qolgan hollarda serverning
 * o'z matni ko'rsatiladi. Xato matni har doim to'liq ko'rinadi — umumiy
 * "xatolik yuz berdi" bilan almashtirilmaydi.
 */
const FAILURE_EXPLANATIONS: Array<{ test: RegExp; uz: string }> = [
	{
		test: /no caller speech was transcribed/i,
		uz: "Mijoz gapi yozib olinmagan — tahlil qiladigan matn yo'q",
	},
	{
		test: /does not exist or you do not have access/i,
		uz: "AI modelga ruxsat yo'q — kalit yoki model sozlamasini tekshirish kerak",
	},
	{
		test: /OPENAI_API_KEY is not set/i,
		uz: "OPENAI_API_KEY sozlanmagan — xulosa yaratib bo'lmaydi",
	},
	{
		test: /could not be reached/i,
		uz: "Tahlil modeliga ulanib bo'lmadi (tarmoq yoki timeout)",
	},
	{
		test: /returned HTTP \d+/i,
		uz: "Tahlil modeli xato javob qaytardi",
	},
	{
		test: /did not return JSON|did not match the expected shape|returned an empty answer/i,
		uz: "Model javobi kutilgan formatda emas",
	},
	{
		test: /provayder ulanmadi|ishga tushmadi/i,
		uz: "AI ovozli provayder ulanmadi — qo'ng'iroq zaxira IVR orqali o'tgan",
	},
];

export interface FailureExplanation {
	/** Qisqa o'zbekcha izoh (tanilgan naqsh bo'lsa). */
	title: string | null;
	/** Serverdagi asl matn — har doim ko'rsatiladi. */
	raw: string;
}

export function explainFailure(errorMessage: string | null): FailureExplanation | null {
	if (!errorMessage) {
		return null;
	}

	const match = FAILURE_EXPLANATIONS.find((entry) => entry.test.test(errorMessage));

	return { title: match?.uz ?? null, raw: errorMessage };
}
