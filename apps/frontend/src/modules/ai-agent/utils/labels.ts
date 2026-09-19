import type { UnknownAnswerPolicy, WeekDayKey } from "../types";

const LANGUAGE_NAMES: Record<string, string> = {
	uz: "O'zbekcha",
	ru: "Ruscha",
	en: "Inglizcha",
	kk: "Qozoqcha",
	tr: "Turkcha",
	tg: "Tojikcha",
	ky: "Qirg'izcha",
};

export function languageLabel(code: string): string {
	return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

export const LANGUAGE_OPTIONS = Object.keys(LANGUAGE_NAMES).map((code) => ({
	value: code,
	label: `${LANGUAGE_NAMES[code]} (${code})`,
}));

/**
 * GET /api/ai-assistant/config `knownVoices` ni bermasa ishlatiladigan ro'yxat.
 * Backenddagi KNOWN_REALTIME_VOICES bilan bir xil.
 */
export const FALLBACK_VOICES = [
	"alloy",
	"ash",
	"ballad",
	"cedar",
	"coral",
	"echo",
	"marin",
	"sage",
	"shimmer",
	"verse",
];

interface PolicyOption {
	value: UnknownAnswerPolicy;
	label: string;
	/** Biznes egasi uchun sodda tushuntirish — texnik atamalarsiz. */
	hint: string;
	/** Qo'ng'iroqda taxminan qanday eshitiladi. */
	sample: string;
}

/**
 * Bilim bazasida javob bo'lmaganda AI nima qilishi.
 *
 * Uchtasining hech birida AI javobni o'zidan to'qib chiqarmaydi: narx, manzil
 * yoki ish vaqtini o'ylab aytish yozib olinadigan liniyada biznes uchun
 * javobgarlik demakdir.
 */
export const UNKNOWN_POLICY_OPTIONS: PolicyOption[] = [
	{
		value: "transfer",
		label: "Operatorga uzatish",
		hint: "AI javobni bilmasa, qo'ng'iroqni tirik xodimga o'tkazadi. Ish vaqtida xodim doim bo'lsa — eng xavfsiz tanlov.",
		sample: "«Buni aniq aytishim uchun mutaxassisga ulab beraman, bir daqiqa.»",
	},
	{
		value: "take_message",
		label: "Xabar olib qolish",
		hint: "AI savolni va mijozning telefon raqamini yozib oladi, so'ng keyingi aloqa vazifasi sifatida saqlaydi. Xodim keyin o'zi qo'ng'iroq qiladi.",
		sample:
			"«Savolingizni yozib oldim, mutaxassis siz bilan bog'lanadi. Raqamingizni tasdiqlaysizmi?»",
	},
	{
		value: "say_unknown",
		label: "Bilmasligini aytish",
		hint: "AI ochiq aytadi: bu savolga javob bera olmayman — va odam bilan gaplashishni taklif qiladi. Hech narsa to'qilmaydi, hech narsa yozilmaydi.",
		sample: "«Kechirasiz, bu savolga javobim yo'q. Xodim bilan gaplashishni istaysizmi?»",
	},
];

export function unknownPolicyLabel(policy: UnknownAnswerPolicy | undefined): string {
	return UNKNOWN_POLICY_OPTIONS.find((item) => item.value === policy)?.label ?? "—";
}

export const WEEK_DAYS: { key: WeekDayKey; label: string; short: string }[] = [
	{ key: "mon", label: "Dushanba", short: "Du" },
	{ key: "tue", label: "Seshanba", short: "Se" },
	{ key: "wed", label: "Chorshanba", short: "Ch" },
	{ key: "thu", label: "Payshanba", short: "Pa" },
	{ key: "fri", label: "Juma", short: "Ju" },
	{ key: "sat", label: "Shanba", short: "Sh" },
	{ key: "sun", label: "Yakshanba", short: "Ya" },
];

/** Ko'p ishlatiladigan vaqt mintaqalari + brauzerdagi joriy mintaqa. */
export function timezoneOptions(): { value: string; label: string }[] {
	const common = [
		"Asia/Tashkent",
		"Asia/Samarkand",
		"Asia/Almaty",
		"Asia/Dubai",
		"Europe/Moscow",
		"Europe/Istanbul",
		"UTC",
	];

	let local = "";
	try {
		local = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
	} catch {
		local = "";
	}

	const all = local && !common.includes(local) ? [local, ...common] : common;

	return all.map((zone) => ({
		value: zone,
		label: zone === local ? `${zone} (brauzeringiz)` : zone,
	}));
}

/** 900 → "15 daqiqa" — chegaralarni odam o'qiy oladigan ko'rinishda ko'rsatish. */
export function humanizeSeconds(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return "—";
	}
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes === 0) {
		return `${rest} sekund`;
	}
	if (rest === 0) {
		return `${minutes} daqiqa`;
	}
	return `${minutes} daqiqa ${rest} sekund`;
}

export function humanizeMs(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) {
		return "—";
	}
	return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} sekund`;
}
