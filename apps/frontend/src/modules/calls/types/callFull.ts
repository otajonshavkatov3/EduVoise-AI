/**
 * `GET /calls/{id}/full` javobi — bitta qo'ng'iroq haqidagi hamma narsa.
 *
 * Backenddagi calls.full.schemas.ts bilan maydonma-maydon bir xil. Ikkita qoida
 * shu faylning hammasiga tegishli:
 *   - hisoblab bo'lmagan son `null`, hech qachon 0 emas;
 *   - id emas, nom qaytadi (operator, mas'ul xodim) — nomni brauzerda qidirish
 *     kerak emas.
 */
import type { AiSessionCost } from "@/modules/ai-assistant/types";
import type { Sentiment } from "./analysis";
import type { AIStatus, CallDirection, CallStatus } from "./index";
import type { TranscriptLine } from "./transcript";

export type AiSessionStatus = "initializing" | "active" | "transferring" | "completed" | "failed";

export type TransferStatus = "requested" | "ringing" | "connected" | "failed" | "abandoned";

export type FollowUpStatus = "open" | "in_progress" | "done" | "cancelled";

export type BookingStatus = "scheduled" | "confirmed" | "cancelled" | "completed";

export type NoteAuthorType = "ai" | "operator" | "system";

export type TicketStatus = "new" | "in_progress" | "resolved" | "closed" | "reopened";

export type TicketPriority = "low" | "medium" | "high";

export interface NamedOperator {
	id: string;
	name: string;
	extension: string | null;
}

export interface NamedUser {
	id: string;
	name: string;
}

export interface CallFullContact {
	id: string;
	phoneNumber: string;
	firstName: string | null;
	lastName: string | null;
}

export interface CallFullOperator {
	id: string;
	phone: string;
	username: string | null;
	extension: string | null;
}

export interface CallFullCall {
	id: string;
	direction: CallDirection;
	callerNumber: string;
	calleeExtension: string | null;
	contactId: string | null;
	contactName: string | null;
	operatorId: string | null;
	ticketId: string | null;
	status: CallStatus;
	duration: number | null;
	recordingPath: string | null;
	aiStatus: AIStatus | null;
	startedAt: string;
	/** Null — qo'ng'iroq umuman javobsiz qolgan. */
	answeredAt: string | null;
	/** Javob berishgacha kutilgan soniya. Null — javob berilmagan. */
	waitSeconds: number | null;
	endedAt: string | null;
	createdAt: string;
	contact: CallFullContact | null;
	operator: CallFullOperator | null;
	/** Operator ismi (username, bo'lmasa telefon raqami). */
	operatorName: string | null;
}

export interface CallFullRecording {
	/** Null — yozuv faqat `calls.recording_path` da, `call_recordings` da qatori yo'q. */
	id: string | null;
	fileName: string;
	/** API ildiziga nisbatan yo'l: `/uploads/call-recordings/<fayl>`. */
	url: string;
	format: string;
	sizeBytes: number | null;
	durationSeconds: number | null;
	/** false — qator bor, fayl yo'q. */
	isAvailable: boolean;
	createdAt: string | null;
}

export interface CallFullTranscripts {
	items: TranscriptLine[];
	total: number;
	truncated: boolean;
	includesInterim: boolean;
}

export interface CallFullAnalysis {
	id: string;
	status: AIStatus;
	summary: string | null;
	sentiment: Sentiment | null;
	categories: string[] | null;
	confidence: number | null;
	errorMessage: string | null;
	retryCount: number;
	hasTranscript: boolean;
	transcriptChars: number;
	processedAt: string | null;
	createdAt: string;
}

export interface CallFullSessionTokens {
	promptTokens: number | null;
	cachedPromptTokens: number | null;
	inputTextTokens: number | null;
	inputAudioTokens: number | null;
	completionTokens: number | null;
	outputTextTokens: number | null;
	outputAudioTokens: number | null;
	transcribeAudioTokens: number | null;
	transcribeTextTokens: number | null;
	transcribeModel: string | null;
}

export interface CallFullSession {
	id: string;
	channelId: string | null;
	provider: string;
	model: string | null;
	voice: string | null;
	language: string | null;
	status: AiSessionStatus;
	interruptions: number;
	inputAudioMs: number;
	outputAudioMs: number;
	responseTurns: number | null;
	durationMs: number | null;
	tokens: CallFullSessionTokens;
	errorMessage: string | null;
	startedAt: string;
	endedAt: string | null;
}

/**
 * Xarajat maydonlari `AiSessionCost` bilan bir xil — ikkalasi ham backenddagi
 * `buildSessionCostView` dan chiqadi. Shu sababli AI sessiyasi sahifasidagi
 * `SessionCostCard` shu yerda ham ishlatiladi va ikki sahifa bir-biriga zid
 * raqam ko'rsata olmaydi.
 */
export type CallFullCost = AiSessionCost;

export interface CallFullTicket {
	id: string;
	subject: string;
	description: string;
	category: string | null;
	priority: TicketPriority;
	status: TicketStatus;
	externalRefId: string | null;
	createdAt: string;
	closedAt: string | null;
}

export interface CallFullTransfer {
	id: string;
	toExtension: string;
	toOperator: NamedOperator | null;
	/** AI nima uchun odamga uzatgani — tool chaqiruvidan yozilgan. */
	reason: string | null;
	status: TransferStatus;
	requestedAt: string;
	connectedAt: string | null;
	endedAt: string | null;
	waitSeconds: number | null;
	talkSeconds: number | null;
}

export interface CallFullFollowUp {
	id: string;
	title: string;
	description: string | null;
	dueAt: string | null;
	status: FollowUpStatus;
	/** true — AI yaratgan, false — operator qo'lda kiritgan. */
	createdBySystem: boolean;
	isOverdue: boolean;
	assignee: NamedOperator | null;
	ticketId: string | null;
	createdAt: string;
	completedAt: string | null;
}

export interface CallFullBooking {
	id: string;
	title: string;
	notes: string | null;
	scheduledAt: string;
	endsAt: string;
	durationMinutes: number;
	location: string | null;
	status: BookingStatus;
	createdBySystem: boolean;
	assignee: NamedOperator | null;
	ticketId: string | null;
	createdAt: string;
}

export interface CallFullNote {
	id: string;
	authorType: NoteAuthorType;
	/** Null — AI yoki tizim yozgan (authorType shuni aytadi). */
	author: NamedUser | null;
	content: string;
	createdAt: string;
	updatedAt: string;
}

export interface CallFullActions {
	ticket: CallFullTicket | null;
	transfers: CallFullTransfer[];
	followUps: CallFullFollowUp[];
	bookings: CallFullBooking[];
	notes: CallFullNote[];
	counts: {
		tickets: number;
		transfers: number;
		followUps: number;
		bookings: number;
		notes: number;
	};
	isEmpty: boolean;
}

export interface CallFull {
	call: CallFullCall;
	recording: CallFullRecording | null;
	/** Uzatilgan qo'ng'iroqda ikkita fayl bo'lishi mumkin. */
	recordings: CallFullRecording[];
	transcripts: CallFullTranscripts;
	analysis: CallFullAnalysis | null;
	session: CallFullSession | null;
	/**
	 * `costVisible` ikki xil null'ni ajratadi: false — rol xarajatni ko'rmaydi,
	 * true va cost=null — narxlanadigan hech narsa yo'q.
	 */
	cost: CallFullCost | null;
	costVisible: boolean;
	actions: CallFullActions;
}

export interface CallFullResponse {
	success: boolean;
	data: CallFull;
}
