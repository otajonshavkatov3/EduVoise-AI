/**
 * Biznes profili — AI operator kim uchun javob berayotgani.
 *
 * Bu yerdagi barcha maydonlar bazadan keladi: platforma bitta biznesga
 * qotib qolgan emas. Shakl backend `ai_agent_profiles` jadvaliga mos.
 */

/** Bilim bazasida javob topilmaganda AI nima qilishi kerak. */
export type UnknownAnswerPolicy = "transfer" | "take_message" | "say_unknown";

export type WeekDayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** ["09:00", "18:00"] — backend shu ko'rinishda o'qiydi. */
export type TimeRange = [string, string];

/**
 * `{ tz, days: { mon: [["09:00","18:00"]], ... } }`
 *
 * Kun kaliti umuman yo'q bo'lsa — "sozlanmagan", AI qo'ng'iroqni qabul qiladi.
 * Kun bor, lekin oraliqlari bo'sh bo'lsa — o'sha kun yopiq.
 */
export interface BusinessHours {
	tz?: string;
	days?: Partial<Record<WeekDayKey, TimeRange[]>>;
}

// ===========================================
// GET / PATCH /api/ai-agent/profile
// ===========================================

/**
 * Hozir qo'ng'iroqlarga javob berayotgan profil.
 *
 * Backend `ActiveAgentProfile` shaklini qaytaradi: hech qanday profil
 * yaratilmagan bo'lsa `id` null va `isConfigured` false bo'ladi — bunday holatda
 * AI ehtiyotkor standart sozlamalar bilan ishlaydi.
 */
export interface ActiveAgentProfile {
	id: string | null;
	businessName: string;
	industry: string | null;
	businessDescription: string | null;
	language: string;
	additionalLanguages: string[];
	voice: string;
	greeting: string | null;
	recordingNotice: string | null;
	customInstructions: string | null;
	ticketCategories: string[];
	unknownPolicy: UnknownAnswerPolicy;
	transferExtensions: string[];
	businessHours: BusinessHours | null;
	afterHoursMessage: string | null;
	maxCallSeconds: number;
	silenceHangupMs: number;
	/** false — hali hech narsa sozlanmagan, standart qiymatlar ishlatilmoqda. */
	isConfigured: boolean;
	/** Backend qo'shsa ko'rsatiladi; yo'q bo'lsa UI ularsiz ishlaydi. */
	isActive?: boolean;
	createdAt?: string;
	updatedAt?: string;
	knowledgeEntryCount?: number;
}

export interface ActiveAgentProfileResponse {
	success: boolean;
	data: ActiveAgentProfile;
}

/**
 * Backenddan kelgan xom profil.
 *
 * `isConfigured` javob sxemasida yo'q — u faqat qo'ng'iroq yo'lidagi ichki
 * shaklda bor. Servis uni javobning o'zidan chiqarib beradi, shuning uchun UI
 * tipida maydon majburiy bo'lib qolaveradi (backend keyin qo'shsa ham ishlaydi).
 */
export interface RawActiveAgentProfile extends Omit<ActiveAgentProfile, "isConfigured"> {
	isConfigured?: boolean;
}

export interface RawActiveAgentProfileResponse {
	success: boolean;
	data: RawActiveAgentProfile;
}

/** PATCH — faqat o'zgargan maydonlar yuboriladi. */
export interface AgentProfilePatch {
	businessName?: string;
	industry?: string | null;
	businessDescription?: string | null;
	language?: string;
	additionalLanguages?: string[];
	voice?: string;
	greeting?: string | null;
	recordingNotice?: string | null;
	customInstructions?: string | null;
	ticketCategories?: string[];
	unknownPolicy?: UnknownAnswerPolicy;
	transferExtensions?: string[];
	businessHours?: BusinessHours | null;
	afterHoursMessage?: string | null;
	maxCallSeconds?: number;
	silenceHangupMs?: number;
}

// ===========================================
// /api/ai-agent/profiles
// ===========================================

/** Ro'yxatdagi profil — qatorning o'zi. Qo'shimcha maydonlar ixtiyoriy. */
export interface AgentProfileSummary {
	id: string;
	businessName: string;
	industry?: string | null;
	language?: string;
	voice?: string;
	unknownPolicy?: UnknownAnswerPolicy;
	isActive: boolean;
	createdAt?: string;
	updatedAt?: string;
	knowledgeEntryCount?: number;
}

export interface AgentProfilesResponse {
	items: AgentProfileSummary[];
	meta: {
		total: number;
		page: number;
		limit: number;
		totalPages: number;
	} | null;
}

export interface CreateAgentProfileRequest {
	businessName: string;
	industry?: string;
	businessDescription?: string;
	language?: string;
	voice?: string;
}

export interface AgentProfileMutationResponse {
	success: boolean;
	data: unknown;
}
