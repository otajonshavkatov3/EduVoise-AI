/**
 * Hisobot faylidagi qiymatlarni TZ 14.3 talablariga moslashtirish:
 *   sana/vaqt — DD.MM.YYYY HH:mm (24 soatlik), telefon — +998 XX XXX XX XX.
 *
 * Server UTC'da ishlashi mumkin, foydalanuvchi esa Toshkent vaqtini kutadi.
 * Shu sababli barcha vaqtlar Intl orqali REPORT_TIME_ZONE ga o'giriladi —
 * qattiq kodlangan +5 siljish ishlatilmaydi.
 */

export const REPORT_TIME_ZONE = "Asia/Tashkent";

const zonedFormatter = new Intl.DateTimeFormat("en-GB", {
	timeZone: REPORT_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

type ZonedParts = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

function zonedParts(date: Date): ZonedParts {
	const parts = zonedFormatter.formatToParts(date);
	const pick = (type: Intl.DateTimeFormatPartTypes): number => {
		const value = parts.find((part) => part.type === type)?.value;

		return value ? Number(value) : 0;
	};

	return {
		year: pick("year"),
		month: pick("month"),
		day: pick("day"),
		hour: pick("hour"),
		minute: pick("minute"),
		second: pick("second"),
	};
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0");
}

/** "05.08.2026 14:32" — CSV va sarlavhalar uchun. */
export function formatDateTime(date: Date | null | undefined): string {
	if (!date) {
		return "";
	}

	const parts = zonedParts(date);

	return `${pad2(parts.day)}.${pad2(parts.month)}.${parts.year} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** "05.08.2026" — fayl nomi va oraliq yozuvlari uchun. */
export function formatDate(date: Date | null | undefined): string {
	if (!date) {
		return "";
	}

	const parts = zonedParts(date);

	return `${pad2(parts.day)}.${pad2(parts.month)}.${parts.year}`;
}

/** "2026-08-05" — fayl nomida tartiblanadigan ko'rinish. */
export function formatDateForFileName(date: Date | null | undefined): string {
	if (!date) {
		return "";
	}

	const parts = zonedParts(date);

	return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/**
 * ExcelJS sanani `date.getTime()` bo'yicha yozadi, ya'ni UTC devor-vaqtini.
 * Excel katakchasida Toshkent vaqti ko'rinishi uchun zonadagi devor-vaqtini
 * UTC deb qayta quramiz — natijada numFmt bilan to'g'ri ko'rinadi va Excel
 * ichida sana sifatida tartiblanadi.
 */
export function toExcelDate(date: Date | null | undefined): Date | null {
	if (!date) {
		return null;
	}

	const parts = zonedParts(date);

	return new Date(
		Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
	);
}

/**
 * "+998 90 123 45 67". Raqamni tanib bo'lmasa (masalan ichki extension yoki
 * xalqaro raqam) — asl qiymat qaytariladi, formatlash o'ylab topilmaydi.
 */
export function formatUzPhone(raw: string | null | undefined): string {
	if (!raw) {
		return "";
	}

	const digits = raw.replace(/\D/g, "");
	let local: string | null = null;

	if (digits.length === 12 && digits.startsWith("998")) {
		local = digits.slice(3);
	} else if (digits.length === 9) {
		local = digits;
	}

	if (!local) {
		return raw;
	}

	return `+998 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 7)} ${local.slice(7, 9)}`;
}

/** Hisoblab bo'lmagan ko'rsatkich uchun yagona matn — 0 yozilmaydi. */
export const NO_DATA_LABEL = "ma'lumot yo'q";

/** 125 -> "02:05"; 3725 -> "01:02:05". Namuna bo'lmasa (null) — "ma'lumot yo'q". */
export function formatDuration(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) {
		return NO_DATA_LABEL;
	}

	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;

	if (hours > 0) {
		return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`;
	}

	return `${pad2(minutes)}:${pad2(secs)}`;
}

export function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return NO_DATA_LABEL;
	}

	return `${value}%`;
}

/** Bo'sh qatorlarga tayanmasdan ism yig'ish. Ikkisi ham bo'sh bo'lsa — null. */
export function joinName(
	firstName: string | null | undefined,
	lastName: string | null | undefined
): string | null {
	const name = [firstName, lastName].filter(Boolean).join(" ").trim();

	return name.length > 0 ? name : null;
}
