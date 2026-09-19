import { formatDuration as formatSharedDuration } from "@/shared/utils/datetime";
import type { DashboardPeriod } from "../types";

/** Hisoblab bo'lmagan ko'rsatkich uchun yagona matn. 0 yozish yolg'on bo'lardi. */
export const NO_DATA_LABEL = "ma'lumot yo'q";

export const PERIOD_LABELS: Record<DashboardPeriod, string> = {
	day: "Kun",
	week: "Hafta",
	month: "Oy",
};

/** KPI izohlarida ishlatiladi: "bugun", "oxirgi 7 kun", "oxirgi 30 kun". */
export const PERIOD_PHRASES: Record<DashboardPeriod, string> = {
	day: "bugun",
	week: "oxirgi 7 kun",
	month: "oxirgi 30 kun",
};

export const EMPTY_CHART_MESSAGES: Record<DashboardPeriod, string> = {
	day: "Bugun hali qo'ng'iroq yo'q",
	week: "Oxirgi 7 kunda qo'ng'iroq yo'q",
	month: "Oxirgi 30 kunda qo'ng'iroq yo'q",
};

/** Sekundni "5 daq 12 s" ko'rinishida. null bo'lsa NO_DATA_LABEL qaytaradi. */
export function formatDuration(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) {
		return NO_DATA_LABEL;
	}

	return formatSharedDuration(seconds);
}

/** Grafik tooltipida joy tejash uchun "m:ss" ko'rinishi. */
export function formatClock(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) {
		return NO_DATA_LABEL;
	}

	const whole = Math.max(0, Math.round(seconds));
	const minutes = Math.floor(whole / 60);

	return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Oldingi davrga nisbatan o'zgarish foizi.
 *
 * Oldingi davr 0 bo'lsa (yoki ko'rsatkich hisoblanmagan bo'lsa) null qaytadi —
 * nolga bo'lishdan "+100%" kabi ma'nosiz son chiqarilmaydi va UI belgisiz qoladi.
 */
export function percentChange(
	current: number | null | undefined,
	previous: number | null | undefined
): number | null {
	if (
		current === null ||
		current === undefined ||
		previous === null ||
		previous === undefined ||
		previous === 0
	) {
		return null;
	}

	return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Sonni foiz sifatida: 66.7 -> "66,7%". null bo'lsa NO_DATA_LABEL. */
export function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return NO_DATA_LABEL;
	}

	return `${value.toFixed(1).replace(".", ",")}%`;
}

/** Ulushni butun foizga: 3/7 -> "43%". Maxraj 0 bo'lsa "0%". */
export function shareOf(value: number, total: number): string {
	if (total <= 0) {
		return "0%";
	}

	return `${Math.round((value / total) * 100)}%`;
}

export { formatDate, formatTime } from "@/shared/utils/datetime";
