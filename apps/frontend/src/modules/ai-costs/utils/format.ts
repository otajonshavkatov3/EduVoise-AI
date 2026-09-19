import dayjs from "dayjs";
import type { GroupBy, UnpricedReason } from "../types";

/**
 * The one sentinel for a figure that could not be computed.
 *
 * Matches modules/reports/utils/format.ts so the two pages say the same thing.
 * Money must never fall back to "0 so'm": a call whose usage went missing costs
 * an unknown amount, not nothing.
 */
export const NO_DATA = "ma'lumot yo'q";

/**
 * A line that does not exist on this provider, as opposed to one whose value is
 * unknown. Gemini transcribes inside the conversation and is never billed for it
 * separately, so its 0 is structural - printing "$0.00" would read as a measured
 * charge of nothing.
 */
export const NOT_APPLICABLE = "tegishli emas";

/**
 * Enough decimals to keep a cheap call from rounding to $0.00.
 * A short Gemini call can genuinely cost a fraction of a cent.
 */
function usdDecimals(value: number): number {
	if (value === 0) {
		return 2;
	}
	if (Math.abs(value) < 0.01) {
		return 5;
	}
	if (Math.abs(value) < 1) {
		return 4;
	}

	return 2;
}

export function formatUsd(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return NO_DATA;
	}

	return `$${value.toFixed(usdDecimals(value))}`;
}

/** So'm faqat kurs kiritilgan bo'lsa ko'rsatiladi — o'ylab topilgan kurs yo'q. */
export function formatUzs(value: number | null | undefined): string | null {
	if (value === null || value === undefined) {
		return null;
	}

	return `${new Intl.NumberFormat("uz-UZ").format(Math.round(value))} so'm`;
}

export function formatTokens(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return NO_DATA;
	}

	return new Intl.NumberFormat("uz-UZ").format(value);
}

/** 1 214 911 -> "1,21 mln". Katta token sonlari uchun. */
export function formatTokensShort(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return NO_DATA;
	}

	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(2).replace(".", ",")} mln`;
	}

	if (value >= 1000) {
		return `${(value / 1000).toFixed(1).replace(".", ",")} ming`;
	}

	return String(value);
}

export function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return NO_DATA;
	}

	return `${value}%`;
}

/** 125 -> "02:05", 3725 -> "01:02:05". */
export function formatDuration(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) {
		return NO_DATA;
	}

	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const rest = total % 60;
	const pad = (value: number) => value.toString().padStart(2, "0");

	if (hours > 0) {
		return `${pad(hours)}:${pad(minutes)}:${pad(rest)}`;
	}

	return `${pad(minutes)}:${pad(rest)}`;
}

export function formatDurationMs(ms: number | null | undefined): string {
	return ms === null || ms === undefined ? NO_DATA : formatDuration(Math.round(ms / 1000));
}

export function formatDate(iso: string | null | undefined): string {
	return iso ? dayjs(iso).format("DD.MM.YYYY") : "—";
}

export function formatDateTime(iso: string | null | undefined): string {
	return iso ? dayjs(iso).format("DD.MM.YYYY HH:mm") : "—";
}

/** Diagramma o'qidagi yorliq — guruhlashga qarab kun/hafta/oy. */
export function formatBucketLabel(bucket: string, groupBy: GroupBy): string {
	const date = dayjs(bucket);

	if (groupBy === "month") {
		return date.format("MM.YYYY");
	}

	return date.format("DD.MM");
}

export const GROUP_BY_LABELS: Record<GroupBy, string> = {
	day: "Kunlik",
	week: "Haftalik",
	month: "Oylik",
};

/**
 * Why a session has no price, in the owner's words.
 *
 * Each of these is a different problem: a legacy row is a gap in the records, an
 * unset rate is a gap in the configuration, and the scripted fallback genuinely
 * spends nothing on a model. Collapsing them into one "—" would hide which.
 */
export const UNPRICED_REASON_LABELS: Record<UnpricedReason, string> = {
	"no-usage": "Sessiya token sarfini umuman qayd etmagan",
	"no-breakdown": "Eski sessiya — kesh va audio/matn taqsimoti yozilmagan",
	"provider-not-priced": "Zaxira IVR — model tokenlari sarflanmagan",
	"rates-not-set": "Bu provayder uchun narx kiritilmagan",
};

export function unpricedReasonLabel(reason: UnpricedReason | null): string | null {
	return reason === null ? null : UNPRICED_REASON_LABELS[reason];
}

/** Provayder slug'i -> ko'rsatiladigan nom. Noma'lumi o'zi qaytadi. */
export function providerLabel(provider: string): string {
	if (provider === "openai-realtime") {
		return "OpenAI Realtime";
	}
	if (provider === "gemini-live") {
		return "Gemini Live";
	}
	if (provider === "fallback-ivr") {
		return "Zaxira IVR";
	}

	return provider;
}

/** TZ 14.3: +998 XX XXX XX XX. Tanib bo'lmasa asl qiymat qaytariladi. */
export function formatPhone(raw: string | null | undefined): string {
	if (!raw) {
		return "—";
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
