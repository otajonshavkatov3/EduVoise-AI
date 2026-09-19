import type { CallDirection, CallStatus } from "@/modules/calls/types";

// ===========================================
// Enumlar (backend: live-calls.schemas.ts)
// ===========================================

export type LiveCallStatus =
	| "starting"
	| "live"
	| "transferring"
	| "transferred"
	| "ending"
	| "ended";

export type TransferPhase = "none" | "requested" | "connected" | "failed";

export type TranscriptRole = "caller" | "agent" | "system";

export type AiSessionStatus = "initializing" | "active" | "transferring" | "completed" | "failed";

// ===========================================
// REST modellari
// ===========================================

/** contacts.address jsonb - { tuman, kocha, uy }. */
export interface LiveCallAddress {
	tuman: string;
	kocha: string;
	uy: string;
}

export interface LiveCallContact {
	id: string;
	firstName: string | null;
	lastName: string | null;
	contactName: string | null;
	address: LiveCallAddress | null;
}

export interface LiveCallAiSession {
	id: string;
	status: AiSessionStatus;
	provider: string;
	model: string | null;
	voice: string | null;
	language: string | null;
	interruptions: number;
	inputAudioMs: number;
	outputAudioMs: number;
	errorMessage: string | null;
	startedAt: string;
	endedAt: string | null;
}

/**
 * Orchestrator WebSocket orqali yuboradigan snapshot. REST javobidagi qatorning
 * qism to'plami - `callStatus`, `aiSession` va `operatorId` faqat REST'da bor.
 */
export interface LiveCallSnapshot {
	callId: string;
	channelId: string;
	callerNumber: string;
	direction: CallDirection;
	status: LiveCallStatus;
	provider: string | null;
	aiSessionId: string | null;
	contact: LiveCallContact | null;
	isReturningCaller: boolean;
	previousCallCount: number;
	ticketId: string | null;
	transferExtension: string | null;
	transferStatus: TransferPhase;
	startedAt: string;
	durationSeconds: number;
}

/** GET /api/live-calls bitta qatori. */
export interface LiveCallItem extends LiveCallSnapshot {
	callStatus: CallStatus | null;
	aiSession: LiveCallAiSession | null;
	operatorId: string | null;
}

export interface LiveTranscriptLine {
	id: string;
	role: TranscriptRole;
	content: string;
	startMs: number | null;
	endMs: number | null;
	isFinal: boolean;
	confidence: number | null;
	createdAt: string;
}

export interface LiveCallsResponse {
	success: boolean;
	data: {
		items: LiveCallItem[];
		total: number;
		orchestratorRunning: boolean;
		scopedToOperator: boolean;
	};
}

export interface LiveCallDetail extends LiveCallItem {
	transcript: LiveTranscriptLine[];
	transcriptCount: number;
}

export interface LiveCallDetailResponse {
	success: boolean;
	data: LiveCallDetail;
}

// ===========================================
// Doska (board) uchun mahalliy modellar
// ===========================================

/**
 * Doskadagi bitta qator: REST qatori + faqat brauzerda saqlanadigan maydonlar.
 * `endedAtMs` to'ldirilgach qator qisqa vaqt ko'rinib turadi, keyin tozalanadi.
 */
export interface LiveCallRow extends LiveCallItem {
	/** Qator birinchi marta ko'rilgan vaqt (epoch ms). */
	seenAtMs: number;
	/** Qo'ng'iroq tugagani ma'lum bo'lgan vaqt (epoch ms) yoki null. */
	endedAtMs: number | null;
	/** live_call_ended dagi sabab. */
	endReason: string | null;
	/** live_call_analysis dan kelgan qisqa xulosa. */
	aiSummary: string | null;
	/** live_call_transfer dagi uzatish sababi (operatorga iliq uzatish uchun). */
	transferReason: string | null;
}

/** WS deltalari va REST qatorlari shu ko'rinishga keltiriladi. */
export interface TranscriptEntry {
	key: string;
	role: TranscriptRole;
	content: string;
	isFinal: boolean;
	startMs: number | null;
	endMs: number | null;
	at: string;
}

// ===========================================
// Harakatlar (POST /api/asterisk/...)
// ===========================================

export interface TransferCallRequest {
	callId: string;
	extension?: string;
	reason?: string;
}

export interface TransferCallResponse {
	success: boolean;
	data: {
		callId: string;
		connected: boolean;
		extension: string | null;
		transferId: string | null;
		source: "orchestrator" | "direct";
		strategy: "ari-bridge" | "ami-redirect" | "none" | null;
		callerRetained: boolean;
		alreadyInProgress: boolean;
		failureReason: string | null;
	};
}

export interface HangupCallRequest {
	callId: string;
	reason?: string;
}

export interface HangupCallResponse {
	success: boolean;
	data: {
		callId: string;
		hungUp: boolean;
		source: "orchestrator" | "ari";
		channelId: string | null;
		message: string;
	};
}

// ===========================================
// Transfer nishonlari (GET /api/asterisk/extensions)
// ===========================================

export interface AsteriskExtensionOperator {
	id: string;
	userId: string;
	extension: string;
	currentStatus: "online" | "offline" | "pause" | "busy";
}

export interface AsteriskExtensionLive {
	deviceState: string | null;
	isRegistered: boolean;
	contactCount: number;
	registrationStatus: string | null;
	userAgent: string | null;
	roundtripUsec: number | null;
}

export interface AsteriskExtensionItem {
	id: string;
	extension: string;
	displayName: string | null;
	kind: "sip" | "webrtc" | "ai";
	isEnabled: boolean;
	lastRegisteredAt: string | null;
	lastKnownStatus: string | null;
	createdAt: string;
	updatedAt: string;
	operator: AsteriskExtensionOperator | null;
	live: AsteriskExtensionLive | null;
}

export interface AsteriskExtensionsResponse {
	success: boolean;
	data: {
		items: AsteriskExtensionItem[];
		total: number;
		ami: {
			connected: boolean;
			banner: string | null;
			error: string | null;
		};
		unknownEndpoints: { endpoint: string; deviceState: string }[];
	};
}

// ===========================================
// WebSocket hodisalari
//
// Ro'yxat backenddagi LIVE_CALL_EVENTS bilan aynan bir xil (call-orchestrator.ts).
// Avval bu yerda uchta qo'shimcha nom bor edi — `transcript_delta`,
// `transfer_status`, `ai_session_status` — ularni esa hech bir broadcaster
// yubormasdi, ya'ni ular uchun yozilgan ishlov beruvchilar hech qachon
// chaqirilmagan. Ikki tomon bir xil ro'yxatni ishlatgani ma'qul: shunda
// "nega bu hodisa kelmayapti" degan savol umuman tug'ilmaydi.
// ===========================================

export const LIVE_CALL_EVENT_TYPES = {
	started: "live_call_started",
	updated: "live_call_updated",
	transcript: "live_call_transcript",
	transfer: "live_call_transfer",
	ended: "live_call_ended",
	analysis: "live_call_analysis",
} as const;

export type LiveCallEventType = (typeof LIVE_CALL_EVENT_TYPES)[keyof typeof LIVE_CALL_EVENT_TYPES];

export interface TranscriptDeltaPayload {
	callId: string;
	role: TranscriptRole;
	content: string;
	isFinal: boolean;
	startMs: number | null;
	endMs: number | null;
	at: string;
}

export interface TransferStatusPayload {
	callId: string;
	phase: TransferPhase;
	extension: string | null;
	reason: string | null;
	failureReason: string | null;
	call: LiveCallSnapshot | null;
}

export interface LiveCallEndedPayload {
	callId: string;
	status: CallStatus | null;
	durationSeconds: number | null;
	ticketId: string | null;
	transferExtension: string | null;
	endReason: string | null;
}

export interface LiveCallAnalysisPayload {
	callId: string;
	aiStatus: "completed" | "failed";
	summary: string | null;
}
