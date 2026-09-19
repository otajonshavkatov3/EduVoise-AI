/** Backend: GET /api/reports/{calls,tickets,operators} javob shakllari. */

export type ReportKind = "calls" | "tickets" | "operators";
export type ExportFormat = "xlsx" | "csv";

export type CallStatus = "ringing" | "answered" | "missed" | "abandoned" | "completed";
export type CallDirection = "inbound" | "outbound";
export type AiStatus = "pending" | "processing" | "completed" | "failed";
export type TicketStatus = "new" | "in_progress" | "resolved" | "closed" | "reopened";
export type TicketPriority = "low" | "medium" | "high";
export type Sentiment = "positive" | "neutral" | "negative";
export type OperatorStatus = "online" | "offline" | "pause" | "busy";

export interface PaginationMeta {
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

export interface ReportRange {
	from: string;
	to: string;
	days: number;
	/** Sana/vaqt qiymatlari qaysi zonada ko'rsatilgani (masalan Asia/Tashkent). */
	timeZone: string;
}

export interface CallReportRow {
	id: string;
	startedAt: string;
	answeredAt: string | null;
	endedAt: string | null;
	direction: CallDirection;
	status: CallStatus;
	callerNumber: string;
	calleeExtension: string | null;
	durationSeconds: number | null;
	waitSeconds: number | null;
	contactName: string | null;
	contactPhone: string | null;
	operatorExtension: string | null;
	operatorPhone: string | null;
	ticketId: string | null;
	ticketSubject: string | null;
	aiStatus: AiStatus | null;
}

export interface CallsSummary {
	totalCalls: number;
	inboundCalls: number;
	outboundCalls: number;
	answeredCalls: number;
	missedCalls: number;
	abandonedCalls: number;
	/** null — qo'ng'iroq bo'lmagan, 0% bilan aralashtirmaslik uchun. */
	answeredRate: number | null;
	avgTalkSeconds: number | null;
	totalTalkSeconds: number;
	talkSampleCount: number;
	avgWaitSeconds: number | null;
	totalWaitSeconds: number;
	/** answeredAt to'ldirilgan qatorlar soni — kutish o'rtachasi shundan chiqadi. */
	waitSampleCount: number;
}

export interface TicketReportRow {
	id: string;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
	subject: string;
	category: string | null;
	priority: TicketPriority;
	status: TicketStatus;
	contactName: string | null;
	contactPhone: string | null;
	createdByPhone: string | null;
	createdByUsername: string | null;
	externalRefId: string | null;
	aiSentiment: Sentiment | null;
	aiConfidence: number | null;
	resolutionHours: number | null;
}

export interface TicketsSummary {
	totalTickets: number;
	statusNew: number;
	statusInProgress: number;
	statusResolved: number;
	statusClosed: number;
	statusReopened: number;
	priorityLow: number;
	priorityMedium: number;
	priorityHigh: number;
	sentimentPositive: number;
	sentimentNeutral: number;
	sentimentNegative: number;
	sentimentUnknown: number;
	closedRate: number | null;
	avgResolutionHours: number | null;
	resolutionSampleCount: number;
}

export interface OperatorReportRow {
	operatorId: string;
	userId: string;
	extension: string;
	userPhone: string;
	username: string | null;
	currentStatus: OperatorStatus;
	isDeleted: boolean;
	totalCalls: number;
	inboundCalls: number;
	outboundCalls: number;
	answeredCalls: number;
	missedCalls: number;
	abandonedCalls: number;
	answeredRate: number | null;
	avgTalkSeconds: number | null;
	totalTalkSeconds: number;
	talkSampleCount: number;
	avgWaitSeconds: number | null;
	waitSampleCount: number;
	ticketsCreated: number;
}

export interface OperatorsSummary {
	operatorCount: number;
	totalCalls: number;
	inboundCalls: number;
	outboundCalls: number;
	answeredCalls: number;
	missedCalls: number;
	abandonedCalls: number;
	answeredRate: number | null;
	avgTalkSeconds: number | null;
	totalTalkSeconds: number;
	talkSampleCount: number;
	avgWaitSeconds: number | null;
	waitSampleCount: number;
	ticketsCreated: number;
	/** Operatorga bog'lanmagan qo'ng'iroqlar — jadval qatorlariga kirmaydi. */
	unassignedCalls: number;
}

interface ReportEnvelope<TRow, TSummary> {
	success: boolean;
	data: {
		items: TRow[];
		meta: PaginationMeta;
		summary: TSummary;
		range: ReportRange;
	};
}

export type CallsReportResponse = ReportEnvelope<CallReportRow, CallsSummary>;
export type TicketsReportResponse = ReportEnvelope<TicketReportRow, TicketsSummary>;
export type OperatorsReportResponse = ReportEnvelope<OperatorReportRow, OperatorsSummary>;

/** from/to majburiy: backend oralig'i bo'lmagan so'rovni qabul qilmaydi. */
export interface BaseReportFilters {
	from: string;
	to: string;
	page: number;
	limit: number;
	/** operatorProfiles.id */
	operatorId?: string;
}

export interface CallsReportFilters extends BaseReportFilters {
	status?: CallStatus;
	direction?: CallDirection;
}

export interface TicketsReportFilters extends BaseReportFilters {
	status?: TicketStatus;
	priority?: TicketPriority;
	category?: string;
}

export interface OperatorsReportFilters extends BaseReportFilters {
	direction?: CallDirection;
}

/** Eksport uchun: uchta hisobot filtrlaridan biri (kesishma emas — status enum'lari har xil). */
export type AnyReportFilters = CallsReportFilters | TicketsReportFilters | OperatorsReportFilters;

export interface ExportedFile {
	blob: Blob;
	fileName: string;
}
