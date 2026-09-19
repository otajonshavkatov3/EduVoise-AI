/**
 * Har bir hisobot turi uchun ustunlar, yakuniy qator va xulosa satrlari.
 * Faqat haqiqiy ma'lumotdan hisoblangan qiymatlar yoziladi: hisoblab
 * bo'lmaydigan ko'rsatkich uchun 0 emas, bo'sh katak / "ma'lumot yo'q".
 */
import type { ReportDocument, ReportKeyValue } from "./reports.export";
import {
	formatDate,
	formatDateForFileName,
	formatDateTime,
	formatDuration,
	formatPercent,
	NO_DATA_LABEL,
} from "./reports.format";
import type {
	CallReportRow,
	CallsSummary,
	OperatorReportRow,
	OperatorsSummary,
	ReportRange,
	TicketReportRow,
	TicketsSummary,
} from "./reports.schemas";

const CALL_STATUS_LABELS = new Map<string, string>([
	["ringing", "Chalinmoqda"],
	["answered", "Javob berilgan"],
	["missed", "O'tkazib yuborilgan"],
	["abandoned", "Tashlab ketilgan"],
	["completed", "Tugatilgan"],
]);

const CALL_DIRECTION_LABELS = new Map<string, string>([
	["inbound", "Kiruvchi"],
	["outbound", "Chiquvchi"],
]);

const AI_STATUS_LABELS = new Map<string, string>([
	["pending", "Kutilmoqda"],
	["processing", "Jarayonda"],
	["completed", "Tayyor"],
	["failed", "Xatolik"],
]);

const TICKET_STATUS_LABELS = new Map<string, string>([
	["new", "Yangi"],
	["in_progress", "Jarayonda"],
	["resolved", "Hal qilingan"],
	["closed", "Yopilgan"],
	["reopened", "Qayta ochilgan"],
]);

const TICKET_PRIORITY_LABELS = new Map<string, string>([
	["low", "Past"],
	["medium", "O'rta"],
	["high", "Yuqori"],
]);

const SENTIMENT_LABELS = new Map<string, string>([
	["positive", "Ijobiy"],
	["neutral", "Neytral"],
	["negative", "Manfiy"],
]);

const OPERATOR_STATUS_LABELS = new Map<string, string>([
	["online", "Onlayn"],
	["offline", "Oflayn"],
	["pause", "Tanaffus"],
	["busy", "Band"],
]);

function labelOf(labels: Map<string, string>, value: string | null): string | null {
	if (!value) {
		return null;
	}

	return labels.get(value) ?? value;
}

/** ISO satrni Date'ga o'girish (bo'sh bo'lsa null) — datetime ustunlari uchun. */
function toDate(value: string | null): Date | null {
	return value ? new Date(value) : null;
}

export type ReportContext = {
	range: ReportRange;
	/**
	 * `general.organizationName` sozlamasi. Bo'sh bo'lsa qator umuman
	 * chiqmaydi — eksport sarlavhasida bo'sh "Tashkilot:" turgani yaxshi emas.
	 */
	organizationName?: string;
	/** Qo'llanilgan filtrlar (allaqachon o'zbekcha yorliqlar bilan). */
	filters: ReportKeyValue[];
	/** Eksportni bajargan foydalanuvchi — auditda ham shu yoziladi. */
	exportedBy: string;
	/** Filtrga mos kelgan umumiy qator soni (sahifalanmagan). */
	rowCount: number;
};

function baseMeta(title: string, context: ReportContext): ReportKeyValue[] {
	const from = formatDateTime(new Date(context.range.from));
	const to = formatDateTime(new Date(context.range.to));

	const organization = (context.organizationName ?? "").trim();

	return [
		...(organization.length > 0 ? [{ label: "Tashkilot", value: organization }] : []),
		{ label: "Hisobot", value: title },
		{ label: "Oraliq", value: `${from} — ${to}` },
		{ label: "Oraliq davomiyligi", value: `${context.range.days} kun` },
		{ label: "Vaqt zonasi", value: context.range.timeZone },
		{ label: "Yaratilgan vaqt", value: formatDateTime(new Date()) },
		{ label: "Yuklab oldi", value: context.exportedBy },
		{ label: "Qatorlar soni", value: String(context.rowCount) },
		...context.filters,
	];
}

function fileBaseName(prefix: string, range: ReportRange): string {
	const from = formatDateForFileName(new Date(range.from));
	const to = formatDateForFileName(new Date(range.to));

	return `${prefix}_${from}_${to}`;
}

// --- Qo'ng'iroqlar ------------------------------------------------------------

const CALLS_TITLE = "Qo'ng'iroqlar hisoboti";

export function buildCallsDocument(
	rows: CallReportRow[],
	summary: CallsSummary,
	context: ReportContext
): ReportDocument<CallReportRow> {
	return {
		fileBaseName: fileBaseName("qongiroqlar-hisoboti", context.range),
		sheetName: "Qo'ng'iroqlar",
		columns: [
			{
				header: "Boshlanish vaqti",
				width: 20,
				kind: "datetime",
				value: (row) => toDate(row.startedAt),
			},
			{
				header: "Javob berilgan vaqt",
				width: 20,
				kind: "datetime",
				value: (row) => toDate(row.answeredAt),
			},
			{ header: "Tugash vaqti", width: 20, kind: "datetime", value: (row) => toDate(row.endedAt) },
			{
				header: "Yo'nalish",
				width: 12,
				kind: "text",
				value: (row) => labelOf(CALL_DIRECTION_LABELS, row.direction),
			},
			{
				header: "Holat",
				width: 20,
				kind: "text",
				value: (row) => labelOf(CALL_STATUS_LABELS, row.status),
			},
			{ header: "Mijoz raqami", width: 22, kind: "phone", value: (row) => row.callerNumber },
			{ header: "Ichki raqam", width: 13, kind: "text", value: (row) => row.calleeExtension },
			{ header: "Kutish (soniya)", width: 16, kind: "number", value: (row) => row.waitSeconds },
			{
				header: "Davomiyligi (soniya)",
				width: 20,
				kind: "number",
				value: (row) => row.durationSeconds,
			},
			{ header: "Mijoz", width: 26, kind: "text", value: (row) => row.contactName },
			{ header: "Mijoz telefoni", width: 22, kind: "phone", value: (row) => row.contactPhone },
			{ header: "Operator (ext)", width: 15, kind: "text", value: (row) => row.operatorExtension },
			{ header: "Operator telefoni", width: 22, kind: "phone", value: (row) => row.operatorPhone },
			{ header: "Murojaat mavzusi", width: 34, kind: "text", value: (row) => row.ticketSubject },
			{
				header: "AI holati",
				width: 14,
				kind: "text",
				value: (row) => labelOf(AI_STATUS_LABELS, row.aiStatus),
			},
			{ header: "Qo'ng'iroq ID", width: 38, kind: "text", value: (row) => row.id },
		],
		rows,
		totalsLabel: `JAMI — ${summary.totalCalls} qo'ng'iroq`,
		// Faqat ustun bo'yicha ma'noga ega jamlanmalar: kutish va suhbat sekundlari.
		totalsRow: [
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			summary.waitSampleCount > 0 ? summary.totalWaitSeconds : null,
			summary.totalTalkSeconds,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		],
		meta: baseMeta(CALLS_TITLE, context),
		summary: buildCallsSummaryLines(summary),
	};
}

export function buildCallsSummaryLines(summary: CallsSummary): ReportKeyValue[] {
	return [
		{ label: "Jami qo'ng'iroq", value: String(summary.totalCalls) },
		{ label: "Kiruvchi", value: String(summary.inboundCalls) },
		{ label: "Chiquvchi", value: String(summary.outboundCalls) },
		{ label: "Javob berilgan", value: String(summary.answeredCalls) },
		{ label: "O'tkazib yuborilgan", value: String(summary.missedCalls) },
		{ label: "Tashlab ketilgan", value: String(summary.abandonedCalls) },
		{ label: "Javob berish darajasi", value: formatPercent(summary.answeredRate) },
		{
			label: "O'rtacha suhbat davomiyligi",
			value: formatDuration(summary.avgTalkSeconds),
		},
		{ label: "Jami suhbat vaqti", value: formatDuration(summary.totalTalkSeconds) },
		{
			label: "O'rtacha kutish vaqti",
			value: formatDuration(summary.avgWaitSeconds),
		},
		{
			label: "Jami kutish vaqti",
			value: summary.waitSampleCount > 0 ? formatDuration(summary.totalWaitSeconds) : NO_DATA_LABEL,
		},
		{
			label: "Kutish vaqti namunasi (javob berilgan vaqti yozilgan qatorlar)",
			value: String(summary.waitSampleCount),
		},
	];
}

// --- Murojaatlar (ticketlar) -------------------------------------------------

const TICKETS_TITLE = "Murojaatlar hisoboti";

export function buildTicketsDocument(
	rows: TicketReportRow[],
	summary: TicketsSummary,
	context: ReportContext
): ReportDocument<TicketReportRow> {
	return {
		fileBaseName: fileBaseName("murojaatlar-hisoboti", context.range),
		sheetName: "Murojaatlar",
		columns: [
			{ header: "Yaratilgan", width: 20, kind: "datetime", value: (row) => toDate(row.createdAt) },
			{ header: "Yopilgan", width: 20, kind: "datetime", value: (row) => toDate(row.closedAt) },
			{ header: "Mavzu", width: 40, kind: "text", value: (row) => row.subject },
			{ header: "Kategoriya", width: 20, kind: "text", value: (row) => row.category },
			{
				header: "Prioritet",
				width: 12,
				kind: "text",
				value: (row) => labelOf(TICKET_PRIORITY_LABELS, row.priority),
			},
			{
				header: "Holat",
				width: 18,
				kind: "text",
				value: (row) => labelOf(TICKET_STATUS_LABELS, row.status),
			},
			{
				header: "Hal qilish vaqti (soat)",
				width: 22,
				kind: "decimal",
				value: (row) => row.resolutionHours,
			},
			{ header: "Mijoz", width: 26, kind: "text", value: (row) => row.contactName },
			{ header: "Mijoz telefoni", width: 22, kind: "phone", value: (row) => row.contactPhone },
			{ header: "Yaratuvchi", width: 22, kind: "text", value: (row) => row.createdByUsername },
			{
				header: "Yaratuvchi telefoni",
				width: 22,
				kind: "phone",
				value: (row) => row.createdByPhone,
			},
			{
				header: "AI kayfiyat",
				width: 14,
				kind: "text",
				value: (row) => labelOf(SENTIMENT_LABELS, row.aiSentiment),
			},
			{ header: "AI ishonch (%)", width: 15, kind: "number", value: (row) => row.aiConfidence },
			{ header: "M-Nazorat ID", width: 20, kind: "text", value: (row) => row.externalRefId },
			{ header: "Murojaat ID", width: 38, kind: "text", value: (row) => row.id },
		],
		rows,
		totalsLabel: `JAMI — ${summary.totalTickets} murojaat`,
		// Soatlar yoki ishonch foizini ustun bo'yicha qo'shish ma'nosiz — bo'sh qoldiriladi.
		totalsRow: [],
		meta: baseMeta(TICKETS_TITLE, context),
		summary: buildTicketsSummaryLines(summary),
	};
}

export function buildTicketsSummaryLines(summary: TicketsSummary): ReportKeyValue[] {
	return [
		{ label: "Jami murojaat", value: String(summary.totalTickets) },
		{ label: "Yangi", value: String(summary.statusNew) },
		{ label: "Jarayonda", value: String(summary.statusInProgress) },
		{ label: "Hal qilingan", value: String(summary.statusResolved) },
		{ label: "Yopilgan", value: String(summary.statusClosed) },
		{ label: "Qayta ochilgan", value: String(summary.statusReopened) },
		{ label: "Yopilish darajasi", value: formatPercent(summary.closedRate) },
		{ label: "Prioritet: past", value: String(summary.priorityLow) },
		{ label: "Prioritet: o'rta", value: String(summary.priorityMedium) },
		{ label: "Prioritet: yuqori", value: String(summary.priorityHigh) },
		{ label: "AI kayfiyat: ijobiy", value: String(summary.sentimentPositive) },
		{ label: "AI kayfiyat: neytral", value: String(summary.sentimentNeutral) },
		{ label: "AI kayfiyat: manfiy", value: String(summary.sentimentNegative) },
		{ label: "AI tahlil qilinmagan", value: String(summary.sentimentUnknown) },
		{
			label: "O'rtacha hal qilish vaqti (soat)",
			value:
				summary.avgResolutionHours === null ? NO_DATA_LABEL : String(summary.avgResolutionHours),
		},
		{
			label: "Hal qilish vaqti namunasi (yopilgan murojaatlar)",
			value: String(summary.resolutionSampleCount),
		},
	];
}

// --- Operatorlar -------------------------------------------------------------

const OPERATORS_TITLE = "Operatorlar hisoboti";

export function buildOperatorsDocument(
	rows: OperatorReportRow[],
	summary: OperatorsSummary,
	context: ReportContext
): ReportDocument<OperatorReportRow> {
	return {
		fileBaseName: fileBaseName("operatorlar-hisoboti", context.range),
		sheetName: "Operatorlar",
		columns: [
			{ header: "Ichki raqam", width: 14, kind: "text", value: (row) => row.extension },
			{ header: "Operator", width: 22, kind: "text", value: (row) => row.username },
			{ header: "Telefon", width: 22, kind: "phone", value: (row) => row.userPhone },
			{
				header: "Hozirgi holat",
				width: 15,
				kind: "text",
				value: (row) => labelOf(OPERATOR_STATUS_LABELS, row.currentStatus),
			},
			{
				header: "Profil",
				width: 14,
				kind: "text",
				value: (row) => (row.isDeleted ? "O'chirilgan" : "Faol"),
			},
			{ header: "Jami qo'ng'iroq", width: 16, kind: "number", value: (row) => row.totalCalls },
			{ header: "Kiruvchi", width: 12, kind: "number", value: (row) => row.inboundCalls },
			{ header: "Chiquvchi", width: 12, kind: "number", value: (row) => row.outboundCalls },
			{ header: "Javob berilgan", width: 16, kind: "number", value: (row) => row.answeredCalls },
			{
				header: "O'tkazib yuborilgan",
				width: 20,
				kind: "number",
				value: (row) => row.missedCalls,
			},
			{
				header: "Tashlab ketilgan",
				width: 18,
				kind: "number",
				value: (row) => row.abandonedCalls,
			},
			{ header: "Javob berish (%)", width: 18, kind: "decimal", value: (row) => row.answeredRate },
			{
				header: "O'rtacha suhbat (soniya)",
				width: 24,
				kind: "number",
				value: (row) => row.avgTalkSeconds,
			},
			{
				header: "Jami suhbat (soniya)",
				width: 22,
				kind: "number",
				value: (row) => row.totalTalkSeconds,
			},
			{
				header: "O'rtacha kutish (soniya)",
				width: 24,
				kind: "number",
				value: (row) => row.avgWaitSeconds,
			},
			{
				header: "Kutish namunasi",
				width: 16,
				kind: "number",
				value: (row) => row.waitSampleCount,
			},
			{
				header: "Yaratilgan murojaat",
				width: 20,
				kind: "number",
				value: (row) => row.ticketsCreated,
			},
		],
		rows,
		totalsLabel: `JAMI — ${summary.operatorCount} operator`,
		// O'rtacha va foiz qiymatlari butun oraliq bo'yicha qayta hisoblangan
		// (o'rtachalarning o'rtachasi emas).
		totalsRow: [
			null,
			null,
			null,
			null,
			null,
			summary.totalCalls,
			summary.inboundCalls,
			summary.outboundCalls,
			summary.answeredCalls,
			summary.missedCalls,
			summary.abandonedCalls,
			summary.answeredRate,
			summary.avgTalkSeconds,
			summary.totalTalkSeconds,
			summary.avgWaitSeconds,
			summary.waitSampleCount,
			summary.ticketsCreated,
		],
		meta: baseMeta(OPERATORS_TITLE, context),
		summary: buildOperatorsSummaryLines(summary),
	};
}

export function buildOperatorsSummaryLines(summary: OperatorsSummary): ReportKeyValue[] {
	return [
		{ label: "Operatorlar soni", value: String(summary.operatorCount) },
		{ label: "Jami qo'ng'iroq", value: String(summary.totalCalls) },
		{ label: "Kiruvchi", value: String(summary.inboundCalls) },
		{ label: "Chiquvchi", value: String(summary.outboundCalls) },
		{ label: "Javob berilgan", value: String(summary.answeredCalls) },
		{ label: "O'tkazib yuborilgan", value: String(summary.missedCalls) },
		{ label: "Tashlab ketilgan", value: String(summary.abandonedCalls) },
		{ label: "Javob berish darajasi", value: formatPercent(summary.answeredRate) },
		{ label: "O'rtacha suhbat davomiyligi", value: formatDuration(summary.avgTalkSeconds) },
		{ label: "Jami suhbat vaqti", value: formatDuration(summary.totalTalkSeconds) },
		{ label: "O'rtacha kutish vaqti", value: formatDuration(summary.avgWaitSeconds) },
		{
			label: "Kutish vaqti namunasi (javob berilgan vaqti yozilgan qatorlar)",
			value: String(summary.waitSampleCount),
		},
		{ label: "Yaratilgan murojaatlar", value: String(summary.ticketsCreated) },
		{
			label: "Operatorga bog'lanmagan qo'ng'iroqlar (qatorlarga kirmaydi)",
			value: String(summary.unassignedCalls),
		},
	];
}

/** Filtrlarni xulosa varag'i uchun o'zbekcha yorliqlarga aylantirish. */
export function describeCallFilters(filters: {
	operatorLabel: string | null;
	status: string | null;
	direction: string | null;
}): ReportKeyValue[] {
	return [
		{ label: "Filtr: operator", value: filters.operatorLabel ?? "barchasi" },
		{ label: "Filtr: holat", value: labelOf(CALL_STATUS_LABELS, filters.status) ?? "barchasi" },
		{
			label: "Filtr: yo'nalish",
			value: labelOf(CALL_DIRECTION_LABELS, filters.direction) ?? "barchasi",
		},
	];
}

export function describeTicketFilters(filters: {
	operatorLabel: string | null;
	status: string | null;
	priority: string | null;
	category: string | null;
}): ReportKeyValue[] {
	return [
		{ label: "Filtr: yaratuvchi operator", value: filters.operatorLabel ?? "barchasi" },
		{ label: "Filtr: holat", value: labelOf(TICKET_STATUS_LABELS, filters.status) ?? "barchasi" },
		{
			label: "Filtr: prioritet",
			value: labelOf(TICKET_PRIORITY_LABELS, filters.priority) ?? "barchasi",
		},
		{ label: "Filtr: kategoriya", value: filters.category ?? "barchasi" },
	];
}

export function describeOperatorFilters(filters: {
	operatorLabel: string | null;
	direction: string | null;
}): ReportKeyValue[] {
	return [
		{ label: "Filtr: operator", value: filters.operatorLabel ?? "barchasi" },
		{
			label: "Filtr: yo'nalish",
			value: labelOf(CALL_DIRECTION_LABELS, filters.direction) ?? "barchasi",
		},
	];
}

/** Sana oralig'ining odam o'qiy oladigan ko'rinishi (xato xabarlari uchun). */
export function describeRange(range: ReportRange): string {
	return `${formatDate(new Date(range.from))} — ${formatDate(new Date(range.to))}`;
}
