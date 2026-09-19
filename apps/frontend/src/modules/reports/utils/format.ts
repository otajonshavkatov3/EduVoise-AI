import {
	formatDate as formatSharedDate,
	formatDateTime as formatSharedDateTime,
} from "@/shared/utils/datetime";
import type {
	AiStatus,
	CallDirection,
	CallStatus,
	OperatorStatus,
	Sentiment,
	TicketPriority,
	TicketStatus,
} from "../types";

/** Hisoblab bo'lmagan ko'rsatkich — 0 yozilmaydi (TZ: yolg'on raqam bo'lmasin). */
export const NO_DATA = "ma'lumot yo'q";

/** TZ 14.3: DD.MM.YYYY HH:mm, 24 soatlik. */
export const formatDateTime = formatSharedDateTime;

export const formatDate = formatSharedDate;

/** 125 -> "02:05", 3725 -> "01:02:05". null -> "ma'lumot yo'q". */
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

export function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return NO_DATA;
	}

	return `${value}%`;
}

export function formatHours(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return NO_DATA;
	}

	return `${value} soat`;
}

/** TZ 14.3: +998 XX XXX XX XX. Tanib bo'lmasa asl qiymat qaytariladi. */
export function formatReportPhone(raw: string | null | undefined): string {
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

export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
	ringing: "Chalinmoqda",
	answered: "Javob berilgan",
	missed: "O'tkazib yuborilgan",
	abandoned: "Tashlab ketilgan",
	completed: "Yakunlangan",
};

export const CALL_STATUS_COLORS: Record<CallStatus, string> = {
	ringing: "blue",
	answered: "green",
	missed: "red",
	abandoned: "orange",
	completed: "green",
};

export const CALL_DIRECTION_LABELS: Record<CallDirection, string> = {
	inbound: "Kiruvchi",
	outbound: "Chiquvchi",
};

export const AI_STATUS_LABELS: Record<AiStatus, string> = {
	pending: "Kutilmoqda",
	processing: "Jarayonda",
	completed: "Tayyor",
	failed: "Xatolik",
};

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
	new: "Yangi",
	in_progress: "Jarayonda",
	resolved: "Hal qilingan",
	closed: "Yopilgan",
	reopened: "Qayta ochilgan",
};

export const TICKET_STATUS_COLORS: Record<TicketStatus, string> = {
	new: "blue",
	in_progress: "gold",
	resolved: "green",
	closed: "default",
	reopened: "red",
};

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
	low: "Past",
	medium: "O'rta",
	high: "Yuqori",
};

export const TICKET_PRIORITY_COLORS: Record<TicketPriority, string> = {
	low: "default",
	medium: "blue",
	high: "red",
};

export const SENTIMENT_LABELS: Record<Sentiment, string> = {
	positive: "Ijobiy",
	neutral: "Neytral",
	negative: "Manfiy",
};

export const SENTIMENT_COLORS: Record<Sentiment, string> = {
	positive: "green",
	neutral: "default",
	negative: "red",
};

export const OPERATOR_STATUS_LABELS: Record<OperatorStatus, string> = {
	online: "Onlayn",
	offline: "Oflayn",
	pause: "Tanaffus",
	busy: "Band",
};

export const OPERATOR_STATUS_COLORS: Record<OperatorStatus, string> = {
	online: "green",
	offline: "default",
	pause: "gold",
	busy: "blue",
};
