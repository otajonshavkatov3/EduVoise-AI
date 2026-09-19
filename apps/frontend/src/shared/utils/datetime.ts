import dayjs from "dayjs";

/**
 * Sana/vaqtning yagona ko'rinishi (TZ 14.3: DD.MM.YYYY, 24 soatlik HH:mm).
 *
 * Bu fayl kerak bo'lgan sabab: `toLocaleDateString()` argumentsiz chaqirilsa
 * brauzer tiliga tayanadi — en-US brauzerda "8/6/2026" chiqib, qolgan sahifalar
 * bilan mos kelmasdi.
 */

/** Sana bo'lmaganda ko'rsatiladigan belgi. */
export const EMPTY_VALUE = "—";

type DateInput = string | number | Date | null | undefined;

function parse(value: DateInput) {
	if (value === null || value === undefined || value === "") {
		return null;
	}

	const parsed = dayjs(value);
	return parsed.isValid() ? parsed : null;
}

/** 06.08.2026 */
export function formatDate(value: DateInput): string {
	return parse(value)?.format("DD.MM.YYYY") ?? EMPTY_VALUE;
}

/** 14:05 */
export function formatTime(value: DateInput): string {
	return parse(value)?.format("HH:mm") ?? EMPTY_VALUE;
}

/** 06.08.2026 14:05 */
export function formatDateTime(value: DateInput): string {
	return parse(value)?.format("DD.MM.YYYY HH:mm") ?? EMPTY_VALUE;
}

/** Sekundlarni "45 s" / "5 daq 12 s" / "1 soat 5 daq" ko'rinishida. */
export function formatDuration(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
		return EMPTY_VALUE;
	}

	const whole = Math.max(0, Math.round(seconds));

	if (whole < 60) {
		return `${whole} s`;
	}

	const minutes = Math.floor(whole / 60);
	const rest = whole % 60;

	if (minutes < 60) {
		return rest === 0 ? `${minutes} daq` : `${minutes} daq ${rest} s`;
	}

	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;

	return restMinutes === 0 ? `${hours} soat` : `${hours} soat ${restMinutes} daq`;
}
