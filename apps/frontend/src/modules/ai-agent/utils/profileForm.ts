import type {
	ActiveAgentProfile,
	AgentProfilePatch,
	BusinessHours,
	TimeRange,
	UnknownAnswerPolicy,
	WeekDayKey,
} from "../types";
import { WEEK_DAYS } from "./labels";

/**
 * Bir kunning holati.
 *
 * Backend `isWithinBusinessHours` shunday o'qiydi:
 *   kun kaliti yo'q      → cheklov yo'q, qo'ng'iroq qabul qilinadi ("allday")
 *   kun bor, oraliq yo'q → o'sha kun yopiq ("closed")
 *   oraliqlar bor        → faqat shu oraliqlarda ochiq ("hours")
 * UI shu uch holatni aynan shundayligicha ko'rsatadi, aks holda "Yakshanba"
 * yopiq ko'rinib, aslida qo'ng'iroqlarga javob berib turadi.
 */
export type DayMode = "hours" | "closed" | "allday";

export interface DayDraft {
	mode: DayMode;
	ranges: TimeRange[];
}

export interface ProfileFormValues {
	businessName: string;
	industry: string;
	businessDescription: string;
	language: string;
	additionalLanguages: string[];
	voice: string;
	greeting: string;
	recordingNotice: string;
	customInstructions: string;
	ticketCategories: string[];
	unknownPolicy: UnknownAnswerPolicy;
	transferExtensions: string[];
	/** false — ish vaqti cheklovi yo'q (businessHours = null). */
	hoursEnabled: boolean;
	timezone: string;
	days: Record<WeekDayKey, DayDraft>;
	afterHoursMessage: string;
	maxCallSeconds: number;
	silenceHangupMs: number;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Server sxemasidagi cheklovlar (`ai-agent.schemas.ts`).
 *
 * Shakl ularni oldindan tekshiradi: aks holda UI qabul qilgan qiymat saqlashda
 * 400 bo'lib qaytadi va biznes egasi «hech narsa saqlanmayapti» deb o'ylaydi.
 */
export const MAX_ADDITIONAL_LANGUAGES = 5;
export const MAX_TRANSFER_EXTENSIONS = 10;
export const MAX_TICKET_CATEGORIES = 30;
export const MAX_RANGES_PER_DAY = 4;

const LANGUAGE_CODE_PATTERN = /^[a-z]{2}(-[a-zA-Z]{2,4})?$/;
const EXTENSION_PATTERN = /^\d{2,10}$/;

export function isValidTime(value: string): boolean {
	return TIME_PATTERN.test(value.trim());
}

function toMinutes(value: string): number {
	const [hours, minutes] = value.split(":").map(Number);
	return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** Ish vaqti yoqilganda ko'rsatiladigan boshlang'ich shablon. */
function defaultDays(): Record<WeekDayKey, DayDraft> {
	const days = {} as Record<WeekDayKey, DayDraft>;

	for (const day of WEEK_DAYS) {
		const isWeekend = day.key === "sat" || day.key === "sun";
		days[day.key] = isWeekend
			? { mode: "closed", ranges: [] }
			: { mode: "hours", ranges: [["09:00", "18:00"]] };
	}

	return days;
}

function readDays(hours: BusinessHours | null): Record<WeekDayKey, DayDraft> {
	if (!hours?.days) {
		return defaultDays();
	}

	const days = {} as Record<WeekDayKey, DayDraft>;

	for (const day of WEEK_DAYS) {
		const ranges = hours.days[day.key];

		if (ranges === undefined) {
			days[day.key] = { mode: "allday", ranges: [] };
			continue;
		}

		if (ranges.length === 0) {
			days[day.key] = { mode: "closed", ranges: [] };
			continue;
		}

		days[day.key] = {
			mode: "hours",
			ranges: ranges.map((range) => [range[0] ?? "", range[1] ?? ""] as TimeRange),
		};
	}

	return days;
}

/** null/undefined qiymatlar shaklda bo'sh satr bo'lib turadi. */
function text(value: string | null | undefined): string {
	return value ?? "";
}

function list(value: string[] | null | undefined): string[] {
	return value ? [...value] : [];
}

/** Serverdan kelgan profilni tahrirlanadigan qiymatlarga aylantiradi. */
export function toFormValues(profile: ActiveAgentProfile): ProfileFormValues {
	const hours = profile.businessHours ?? null;

	return {
		businessName: text(profile.businessName),
		industry: text(profile.industry),
		businessDescription: text(profile.businessDescription),
		language: text(profile.language) || "uz",
		additionalLanguages: list(profile.additionalLanguages),
		voice: text(profile.voice) || "alloy",
		greeting: text(profile.greeting),
		recordingNotice: text(profile.recordingNotice),
		customInstructions: text(profile.customInstructions),
		ticketCategories: list(profile.ticketCategories),
		unknownPolicy: profile.unknownPolicy ?? "transfer",
		transferExtensions: list(profile.transferExtensions),
		hoursEnabled: hours !== null,
		timezone: typeof hours?.tz === "string" ? hours.tz : "",
		days: readDays(hours),
		afterHoursMessage: text(profile.afterHoursMessage),
		maxCallSeconds: profile.maxCallSeconds ?? 900,
		silenceHangupMs: profile.silenceHangupMs ?? 20000,
	};
}

export function buildBusinessHours(values: ProfileFormValues): BusinessHours | null {
	if (!values.hoursEnabled) {
		return null;
	}

	const days: Partial<Record<WeekDayKey, TimeRange[]>> = {};

	for (const day of WEEK_DAYS) {
		const draft = values.days[day.key];

		if (draft.mode === "allday") {
			continue;
		}

		if (draft.mode === "closed") {
			days[day.key] = [];
			continue;
		}

		days[day.key] = draft.ranges
			.filter((range) => isValidTime(range[0]) && isValidTime(range[1]))
			.map((range) => [range[0].trim(), range[1].trim()] as TimeRange);
	}

	const timezone = values.timezone.trim();

	return timezone.length > 0 ? { tz: timezone, days } : { days };
}

function sameList(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameHours(left: BusinessHours | null, right: BusinessHours | null): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Bo'shatilganda `null` yuboriladigan matn maydonlari. */
const NULLABLE_TEXT_KEYS = [
	"industry",
	"businessDescription",
	"greeting",
	"recordingNotice",
	"customInstructions",
	"afterHoursMessage",
] as const;

/** Oddiy solishtiriladigan maydonlar — hech qanday normalizatsiya kerak emas. */
const PLAIN_TEXT_KEYS = ["language", "voice"] as const;
const LIST_KEYS = ["additionalLanguages", "ticketCategories", "transferExtensions"] as const;
const NUMBER_KEYS = ["maxCallSeconds", "silenceHangupMs"] as const;

/**
 * Faqat o'zgargan maydonlarni yuboradi.
 *
 * Bo'shatilgan matn maydoni `null` bo'lib ketadi — bazada ustunlar nullable va
 * bo'sh satr saqlab qo'yish "sozlangan, lekin bo'sh" degan chalkash holat yaratadi.
 */
export function buildPatch(
	baseline: ProfileFormValues,
	values: ProfileFormValues
): AgentProfilePatch {
	const patch: AgentProfilePatch = {};

	diffTexts(baseline, values, patch);
	diffLists(baseline, values, patch);
	diffNumbers(baseline, values, patch);
	diffHours(baseline, values, patch);

	if (values.unknownPolicy !== baseline.unknownPolicy) {
		patch.unknownPolicy = values.unknownPolicy;
	}

	return patch;
}

function diffTexts(
	baseline: ProfileFormValues,
	values: ProfileFormValues,
	patch: AgentProfilePatch
): void {
	const name = values.businessName.trim();
	if (name !== baseline.businessName.trim()) {
		patch.businessName = name;
	}

	for (const key of NULLABLE_TEXT_KEYS) {
		const next = values[key].trim();
		if (next !== baseline[key].trim()) {
			patch[key] = next.length > 0 ? next : null;
		}
	}

	for (const key of PLAIN_TEXT_KEYS) {
		if (values[key] !== baseline[key]) {
			patch[key] = values[key];
		}
	}
}

function diffLists(
	baseline: ProfileFormValues,
	values: ProfileFormValues,
	patch: AgentProfilePatch
): void {
	for (const key of LIST_KEYS) {
		if (!sameList(values[key], baseline[key])) {
			patch[key] = [...values[key]];
		}
	}
}

function diffNumbers(
	baseline: ProfileFormValues,
	values: ProfileFormValues,
	patch: AgentProfilePatch
): void {
	for (const key of NUMBER_KEYS) {
		if (values[key] !== baseline[key]) {
			patch[key] = values[key];
		}
	}
}

function diffHours(
	baseline: ProfileFormValues,
	values: ProfileFormValues,
	patch: AgentProfilePatch
): void {
	const nextHours = buildBusinessHours(values);

	if (!sameHours(nextHours, buildBusinessHours(baseline))) {
		patch.businessHours = nextHours;
	}
}

export type ProfileErrors = Partial<Record<keyof ProfileFormValues | "hours", string>>;

/** Saqlashni bloklaydigan xatolar. */
export function validateProfile(values: ProfileFormValues): ProfileErrors {
	const errors: ProfileErrors = {};

	const name = values.businessName.trim();
	if (name.length === 0) {
		errors.businessName = "Biznes nomi kiritilishi shart — AI shu nom bilan salomlashadi";
	} else if (name.length > 150) {
		errors.businessName = "Biznes nomi 150 belgidan oshmasligi kerak";
	}

	if (values.industry.trim().length > 100) {
		errors.industry = "Yo'nalish 100 belgidan oshmasligi kerak";
	}

	if (
		!Number.isInteger(values.maxCallSeconds) ||
		values.maxCallSeconds < 60 ||
		values.maxCallSeconds > 7200
	) {
		errors.maxCallSeconds = "60 dan 7200 sekundgacha bo'lishi kerak";
	}

	if (
		!Number.isInteger(values.silenceHangupMs) ||
		values.silenceHangupMs < 3000 ||
		values.silenceHangupMs > 120000
	) {
		errors.silenceHangupMs = "3000 dan 120000 ms gacha bo'lishi kerak";
	}

	validateLists(values, errors);

	const hoursError = validateHours(values);
	if (hoursError) {
		errors.hours = hoursError;
	}

	return errors;
}

/** Ro'yxat maydonlari — chegara ham, format ham server sxemasidagidek. */
function validateLists(values: ProfileFormValues, errors: ProfileErrors): void {
	if (values.additionalLanguages.some((code) => !LANGUAGE_CODE_PATTERN.test(code))) {
		errors.additionalLanguages = "Til kodi «ru» yoki «en-US» ko'rinishida bo'lishi kerak";
	} else if (values.additionalLanguages.length > MAX_ADDITIONAL_LANGUAGES) {
		errors.additionalLanguages = `Ko'pi bilan ${MAX_ADDITIONAL_LANGUAGES} ta qo'shimcha til saqlanadi`;
	}

	// Bo'sh ro'yxat serverda rad etiladi: agent ticket ochganda kategoriya
	// tanlashi shart. Ilgari UI buni «standart turlar ishlatiladi» deb ko'rsatar,
	// saqlash esa 400 bo'lardi.
	if (values.ticketCategories.length === 0) {
		errors.ticketCategories =
			"Kamida bitta murojaat turi kerak — AI murojaat ochganda shundan tanlaydi";
	} else if (values.ticketCategories.length > MAX_TICKET_CATEGORIES) {
		errors.ticketCategories = `Ko'pi bilan ${MAX_TICKET_CATEGORIES} ta tur saqlanadi`;
	}

	// Server ham shuni tekshiradi: uzatadigan raqamsiz "odamga uzataman" va'dasi
	// bajarilmaydi, shuning uchun bunday profil umuman saqlanmaydi.
	if (values.unknownPolicy === "transfer" && values.transferExtensions.length === 0) {
		errors.transferExtensions =
			"«Operatorga uzatish» tanlangan — kamida bitta ichki raqam kiriting yoki boshqa qoidani tanlang";
	} else if (values.transferExtensions.some((item) => !EXTENSION_PATTERN.test(item))) {
		errors.transferExtensions =
			"Ichki raqam faqat raqamlardan iborat bo'lishi kerak: 2 dan 10 tagacha raqam (masalan 101)";
	} else if (values.transferExtensions.length > MAX_TRANSFER_EXTENSIONS) {
		errors.transferExtensions = `Ko'pi bilan ${MAX_TRANSFER_EXTENSIONS} ta extension saqlanadi`;
	}
}

/** Ish vaqti oraliqlari: birinchi topilgan xato qaytariladi. */
function validateHours(values: ProfileFormValues): string | null {
	if (!values.hoursEnabled) {
		return null;
	}

	// Hamma kun "Kun bo'yi ochiq" bo'lsa `buildBusinessHours` bo'sh `days` beradi,
	// serverda esa kamida bitta kun bo'lishi shart. Bu holat aslida "cheklov yo'q"
	// degani, shuning uchun to'g'ri yechim — switch'ni o'chirish.
	if (WEEK_DAYS.every((day) => values.days[day.key].mode === "allday")) {
		return "Hamma kun «Kun bo'yi ochiq» — bu cheklov yo'q degani. «Ish vaqti cheklovi» tugmasini o'chiring";
	}

	for (const day of WEEK_DAYS) {
		const draft = values.days[day.key];

		if (draft.mode !== "hours") {
			continue;
		}

		if (draft.ranges.length === 0) {
			return `${day.label}: ish vaqti tanlangan, lekin oraliq kiritilmagan`;
		}

		if (draft.ranges.length > MAX_RANGES_PER_DAY) {
			return `${day.label}: bir kunga ko'pi bilan ${MAX_RANGES_PER_DAY} ta oraliq saqlanadi`;
		}

		const broken = draft.ranges.some(
			(range) =>
				!(isValidTime(range[0]) && isValidTime(range[1])) ||
				toMinutes(range[0]) >= toMinutes(range[1])
		);

		if (broken) {
			return `${day.label}: vaqt "09:00" ko'rinishida va boshlanishi tugashidan oldin bo'lishi kerak`;
		}
	}

	return null;
}

/** Bloklamaydigan, lekin aytilishi kerak bo'lgan holatlar. */
export function profileWarnings(values: ProfileFormValues): string[] {
	const warnings: string[] = [];

	if (values.hoursEnabled && values.afterHoursMessage.trim().length === 0) {
		warnings.push(
			"Ish vaqtidan tashqari matn bo'sh — AI umumiy javob beradi. O'z matningizni yozib qo'yish tavsiya etiladi."
		);
	}

	if (values.greeting.trim().length === 0) {
		warnings.push("Salomlashish matni bo'sh — biznes nomi asosida avtomatik matn ishlatiladi.");
	}

	return warnings;
}

/**
 * Mijoz go'shakni ko'targanda taxminan nima eshitadi.
 *
 * "Taxminan": aniq matnni model bir oz o'zgartirib aytishi mumkin, lekin
 * salomlashish + yozib olish ogohlantirishi tartibi shu.
 */
/**
 * Profil hali quti ichidan chiqqan holatdami.
 *
 * `isConfigured` ning o'zi yetarli emas: aktiv profil bo'lmasa backend standart
 * qatorni («Call Center») o'zi yaratadi, ya'ni maydon amalda doim true. Biznes
 * egasi uchun ma'noli savol boshqa — profilga o'z ma'lumoti kiritilganmi. Yo'nalish
 * ham, tavsif ham yo'q va bilim bazasi ham bo'sh bo'lsa, AI hali hech kim
 * nomidan gapira olmaydi.
 */
export function needsProfileSetup(profile: ActiveAgentProfile): boolean {
	if (!profile.isConfigured) {
		return true;
	}

	const hasIdentity =
		(profile.industry?.trim().length ?? 0) > 0 ||
		(profile.businessDescription?.trim().length ?? 0) > 0;

	return !hasIdentity && (profile.knowledgeEntryCount ?? 0) === 0;
}

export function buildGreetingPreview(values: ProfileFormValues): string {
	const name = values.businessName.trim() || "Biznes";
	const greeting =
		values.greeting.trim() || `Assalomu alaykum! "${name}" — raqamli yordamchi eshitmoqda.`;
	const notice = values.recordingNotice.trim();

	return notice.length > 0 ? `${greeting} ${notice}` : greeting;
}
