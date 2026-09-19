import { create } from "zustand";
import type { CallStatus } from "@/modules/calls/types";
import type { WsMessage } from "@/shared/hooks/useWebSocket";
import type {
	LiveCallAnalysisPayload,
	LiveCallEndedPayload,
	LiveCallItem,
	LiveCallRow,
	LiveCallSnapshot,
	LiveTranscriptLine,
	TranscriptDeltaPayload,
	TranscriptEntry,
	TranscriptRole,
	TransferPhase,
	TransferStatusPayload,
} from "../types";
import { LIVE_CALL_EVENT_TYPES } from "../types";

/** Bitta qo'ng'iroq uchun saqlanadigan maksimal transkript qatorlari. */
const MAX_TRANSCRIPT_ENTRIES = 300;

/** Tugagan qo'ng'iroq doskada shuncha vaqt ko'rinib turadi. */
const ENDED_RETENTION_MS = 90_000;

/**
 * REST ro'yxati hali ko'rmagan, lekin WS orqali kelgan qator shuncha vaqt
 * saqlanadi (poll bilan WS orasidagi kechikish uchun).
 */
const FRESH_ROW_GRACE_MS = 15_000;

let transcriptSequence = 0;

function nextTranscriptKey(): string {
	transcriptSequence += 1;
	return `final-${transcriptSequence}`;
}

function interimKey(role: TranscriptRole): string {
	return `interim-${role}`;
}

// ===========================================
// Xavfsiz o'qish yordamchilari
//
// handleWsMessage butun WS trafigini oladi, shuning uchun har bir maydon
// tekshiriladi: noto'g'ri shakl faqat e'tiborsiz qoldiriladi.
// ===========================================

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readNullableNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSnapshot(value: unknown): LiveCallSnapshot | null {
	if (!isRecord(value)) {
		return null;
	}
	if (typeof value.callId !== "string" || typeof value.callerNumber !== "string") {
		return null;
	}
	return value as unknown as LiveCallSnapshot;
}

const TRANSCRIPT_ROLES: TranscriptRole[] = ["caller", "agent", "system"];

function readRole(value: unknown): TranscriptRole | null {
	return TRANSCRIPT_ROLES.includes(value as TranscriptRole) ? (value as TranscriptRole) : null;
}

const TRANSFER_PHASES: TransferPhase[] = ["none", "requested", "connected", "failed"];

function readPhase(value: unknown): TransferPhase | null {
	return TRANSFER_PHASES.includes(value as TransferPhase) ? (value as TransferPhase) : null;
}

const CALL_STATUSES: CallStatus[] = ["ringing", "answered", "missed", "abandoned", "completed"];

function readCallStatus(value: unknown): CallStatus | null {
	return CALL_STATUSES.includes(value as CallStatus) ? (value as CallStatus) : null;
}

// ===========================================
// Qator qurish
// ===========================================

function rowFromSnapshot(
	snapshot: LiveCallSnapshot,
	existing: LiveCallRow | undefined
): LiveCallRow {
	const now = Date.now();
	return {
		...snapshot,
		callStatus: existing?.callStatus ?? null,
		aiSession: existing?.aiSession ?? null,
		operatorId: existing?.operatorId ?? null,
		seenAtMs: existing?.seenAtMs ?? now,
		endedAtMs: existing?.endedAtMs ?? null,
		endReason: existing?.endReason ?? null,
		aiSummary: existing?.aiSummary ?? null,
		transferReason: existing?.transferReason ?? null,
	};
}

function rowFromItem(item: LiveCallItem, existing: LiveCallRow | undefined): LiveCallRow {
	const now = Date.now();
	return {
		...item,
		seenAtMs: existing?.seenAtMs ?? now,
		endedAtMs: existing?.endedAtMs ?? null,
		endReason: existing?.endReason ?? null,
		aiSummary: existing?.aiSummary ?? null,
		transferReason: existing?.transferReason ?? null,
	};
}

function transcriptEntryFromLine(line: LiveTranscriptLine): TranscriptEntry {
	return {
		key: `db-${line.id}`,
		role: line.role,
		content: line.content,
		isFinal: line.isFinal,
		startMs: line.startMs,
		endMs: line.endMs,
		at: line.createdAt,
	};
}

function capTranscript(entries: TranscriptEntry[]): TranscriptEntry[] {
	if (entries.length <= MAX_TRANSCRIPT_ENTRIES) {
		return entries;
	}
	return entries.slice(entries.length - MAX_TRANSCRIPT_ENTRIES);
}

/**
 * Deltani ro'yxatga qo'shadi. Yakuniy bo'lmagan (interim) qator har bir rol
 * uchun bittadan saqlanadi va yangi matn bilan almashtiriladi; yakuniy qator
 * kelganda interim o'rnini bo'shatadi.
 */
function mergeDelta(entries: TranscriptEntry[], delta: TranscriptDeltaPayload): TranscriptEntry[] {
	const key = interimKey(delta.role);

	if (delta.isFinal) {
		const withoutInterim = entries.filter((entry) => entry.key !== key);
		withoutInterim.push({
			key: nextTranscriptKey(),
			role: delta.role,
			content: delta.content,
			isFinal: true,
			startMs: delta.startMs,
			endMs: delta.endMs,
			at: delta.at,
		});
		return capTranscript(withoutInterim);
	}

	const index = entries.findIndex((entry) => entry.key === key);
	const interim: TranscriptEntry = {
		key,
		role: delta.role,
		content: delta.content,
		isFinal: false,
		startMs: delta.startMs,
		endMs: delta.endMs,
		at: delta.at,
	};

	if (index === -1) {
		return capTranscript([...entries, interim]);
	}

	const next = [...entries];
	next[index] = interim;
	return next;
}

// ===========================================
// Store
// ===========================================

interface LiveCallsState {
	calls: Record<string, LiveCallRow>;
	transcripts: Record<string, TranscriptEntry[]>;
	/** REST transkripti bir marta yuklangan qo'ng'iroqlar. */
	seededTranscripts: Record<string, boolean>;
	orchestratorRunning: boolean;
	scopedToOperator: boolean;
	/** Oxirgi WS hodisasi vaqti (ISO), ulanish tirikligini ko'rsatish uchun. */
	lastEventAt: string | null;
}

interface LiveCallsActions {
	hydrate: (payload: {
		items: LiveCallItem[];
		orchestratorRunning: boolean;
		scopedToOperator: boolean;
	}) => void;
	seedTranscript: (callId: string, lines: LiveTranscriptLine[]) => void;
	applySnapshot: (snapshot: LiveCallSnapshot) => void;
	applyTranscriptDelta: (delta: TranscriptDeltaPayload) => void;
	applyTransfer: (payload: TransferStatusPayload) => void;
	applyEnded: (payload: LiveCallEndedPayload) => void;
	applyAnalysis: (payload: LiveCallAnalysisPayload) => void;
	prune: () => void;
	/** WebSocket xabarini qabul qiladi; tanish bo'lmagan turlar e'tiborsiz. */
	handleWsMessage: (msg: WsMessage) => void;
	reset: () => void;
}

type LiveCallsStore = LiveCallsState & LiveCallsActions;

const initialState: LiveCallsState = {
	calls: {},
	transcripts: {},
	seededTranscripts: {},
	orchestratorRunning: false,
	scopedToOperator: false,
	lastEventAt: null,
};

function shouldKeepRow(row: LiveCallRow, now: number): boolean {
	if (row.endedAtMs !== null) {
		return now - row.endedAtMs < ENDED_RETENTION_MS;
	}
	return now - row.seenAtMs < FRESH_ROW_GRACE_MS;
}

function dropOrphanTranscripts(
	transcripts: Record<string, TranscriptEntry[]>,
	calls: Record<string, LiveCallRow>
): Record<string, TranscriptEntry[]> {
	const next: Record<string, TranscriptEntry[]> = {};
	for (const [callId, entries] of Object.entries(transcripts)) {
		if (calls[callId]) {
			next[callId] = entries;
		}
	}
	return next;
}

function dropOrphanSeeds(
	seeds: Record<string, boolean>,
	calls: Record<string, LiveCallRow>
): Record<string, boolean> {
	const next: Record<string, boolean> = {};
	for (const callId of Object.keys(seeds)) {
		if (calls[callId]) {
			next[callId] = true;
		}
	}
	return next;
}

// ===========================================
// WebSocket hodisalari uchun dispatch jadvali
//
// Har bir ishlovchi xabarni o'zi tekshiradi va noto'g'ri shakl bo'lsa jimgina
// chiqib ketadi, shuning uchun begona trafik doskaga ta'sir qilmaydi.
// ===========================================

type WsEventHandler = (store: LiveCallsStore, msg: WsMessage) => void;

function handleSnapshotEvent(store: LiveCallsStore, msg: WsMessage): void {
	const snapshot = readSnapshot(msg.call);
	if (snapshot) {
		store.applySnapshot(snapshot);
	}
}

function handleTranscriptEvent(store: LiveCallsStore, msg: WsMessage): void {
	const callId = readString(msg.callId);
	const role = readRole(msg.role);
	const content = typeof msg.content === "string" ? msg.content : null;

	if (callId === null || role === null || content === null) {
		return;
	}

	store.applyTranscriptDelta({
		callId,
		role,
		content,
		isFinal: readBoolean(msg.isFinal, true),
		startMs: readNullableNumber(msg.startMs),
		endMs: readNullableNumber(msg.endMs),
		at: readString(msg.at) ?? new Date().toISOString(),
	});
}

function handleTransferEvent(store: LiveCallsStore, msg: WsMessage): void {
	const callId = readString(msg.callId);
	// Orchestrator `phase` yuboradi; qisqa nomdagi hodisada `status` bo'lishi mumkin.
	const phase = readPhase(msg.phase) ?? readPhase(msg.status);

	if (callId === null || phase === null) {
		return;
	}

	store.applyTransfer({
		callId,
		phase,
		extension: readString(msg.extension),
		reason: readString(msg.reason),
		failureReason: readString(msg.failureReason),
		call: readSnapshot(msg.call),
	});
}

function handleEndedEvent(store: LiveCallsStore, msg: WsMessage): void {
	const callId = readString(msg.callId);
	if (callId === null) {
		return;
	}

	store.applyEnded({
		callId,
		status: readCallStatus(msg.status),
		durationSeconds: readNullableNumber(msg.durationSeconds),
		ticketId: readString(msg.ticketId),
		transferExtension: readString(msg.transferExtension),
		endReason: readString(msg.endReason),
	});
}

function handleAnalysisEvent(store: LiveCallsStore, msg: WsMessage): void {
	const callId = readString(msg.callId);
	if (callId === null) {
		return;
	}

	store.applyAnalysis({
		callId,
		aiStatus: msg.aiStatus === "failed" ? "failed" : "completed",
		summary: readString(msg.summary),
	});
}

const wsEventHandlers: Record<string, WsEventHandler | undefined> = {
	[LIVE_CALL_EVENT_TYPES.started]: handleSnapshotEvent,
	[LIVE_CALL_EVENT_TYPES.updated]: handleSnapshotEvent,
	[LIVE_CALL_EVENT_TYPES.transcript]: handleTranscriptEvent,
	[LIVE_CALL_EVENT_TYPES.transfer]: handleTransferEvent,
	[LIVE_CALL_EVENT_TYPES.ended]: handleEndedEvent,
	[LIVE_CALL_EVENT_TYPES.analysis]: handleAnalysisEvent,
};

export const useLiveCallsStore = create<LiveCallsStore>((set, get) => ({
	...initialState,

	hydrate: ({ items, orchestratorRunning, scopedToOperator }) =>
		set((state) => {
			const now = Date.now();
			const calls: Record<string, LiveCallRow> = {};

			for (const item of items) {
				calls[item.callId] = rowFromItem(item, state.calls[item.callId]);
			}

			// REST ro'yxati ko'rmagan qatorlar: yaqinda tugaganlar va WS orqali
			// hozir kelganlar saqlanadi, qolganlari tushib qoladi.
			for (const [callId, row] of Object.entries(state.calls)) {
				if (calls[callId]) {
					continue;
				}
				if (shouldKeepRow(row, now)) {
					calls[callId] = row;
				}
			}

			return {
				calls,
				transcripts: dropOrphanTranscripts(state.transcripts, calls),
				seededTranscripts: dropOrphanSeeds(state.seededTranscripts, calls),
				orchestratorRunning,
				scopedToOperator,
			};
		}),

	seedTranscript: (callId, lines) =>
		set((state) => {
			if (state.seededTranscripts[callId]) {
				return state;
			}
			const existing = state.transcripts[callId];
			if (existing && existing.length > 0) {
				return {
					seededTranscripts: { ...state.seededTranscripts, [callId]: true },
				};
			}
			return {
				transcripts: {
					...state.transcripts,
					[callId]: capTranscript(lines.map(transcriptEntryFromLine)),
				},
				seededTranscripts: { ...state.seededTranscripts, [callId]: true },
			};
		}),

	applySnapshot: (snapshot) =>
		set((state) => ({
			calls: {
				...state.calls,
				[snapshot.callId]: rowFromSnapshot(snapshot, state.calls[snapshot.callId]),
			},
			lastEventAt: new Date().toISOString(),
		})),

	applyTranscriptDelta: (delta) =>
		set((state) => ({
			transcripts: {
				...state.transcripts,
				[delta.callId]: mergeDelta(state.transcripts[delta.callId] ?? [], delta),
			},
			lastEventAt: new Date().toISOString(),
		})),

	applyTransfer: (payload) =>
		set((state) => {
			const base = payload.call
				? rowFromSnapshot(payload.call, state.calls[payload.callId])
				: state.calls[payload.callId];

			if (!base) {
				return { lastEventAt: new Date().toISOString() };
			}

			return {
				calls: {
					...state.calls,
					[payload.callId]: {
						...base,
						transferStatus: payload.phase,
						transferExtension: payload.extension ?? base.transferExtension,
						transferReason: payload.reason ?? base.transferReason,
					},
				},
				lastEventAt: new Date().toISOString(),
			};
		}),

	applyEnded: (payload) =>
		set((state) => {
			const row = state.calls[payload.callId];
			if (!row) {
				return { lastEventAt: new Date().toISOString() };
			}

			return {
				calls: {
					...state.calls,
					[payload.callId]: {
						...row,
						status: "ended",
						callStatus: payload.status ?? row.callStatus,
						durationSeconds: payload.durationSeconds ?? row.durationSeconds,
						ticketId: payload.ticketId ?? row.ticketId,
						transferExtension: payload.transferExtension ?? row.transferExtension,
						endedAtMs: Date.now(),
						endReason: payload.endReason ?? row.endReason,
					},
				},
				lastEventAt: new Date().toISOString(),
			};
		}),

	applyAnalysis: (payload) =>
		set((state) => {
			const row = state.calls[payload.callId];
			if (!row) {
				return { lastEventAt: new Date().toISOString() };
			}
			return {
				calls: {
					...state.calls,
					[payload.callId]: { ...row, aiSummary: payload.summary },
				},
				lastEventAt: new Date().toISOString(),
			};
		}),

	prune: () =>
		set((state) => {
			const now = Date.now();
			const calls: Record<string, LiveCallRow> = {};
			let changed = false;

			for (const [callId, row] of Object.entries(state.calls)) {
				if (row.endedAtMs !== null && now - row.endedAtMs >= ENDED_RETENTION_MS) {
					changed = true;
					continue;
				}
				calls[callId] = row;
			}

			if (!changed) {
				return state;
			}

			return {
				calls,
				transcripts: dropOrphanTranscripts(state.transcripts, calls),
				seededTranscripts: dropOrphanSeeds(state.seededTranscripts, calls),
			};
		}),

	handleWsMessage: (msg) => {
		const handler = wsEventHandlers[msg.type];
		if (handler) {
			handler(get(), msg);
		}
	},

	reset: () => set({ ...initialState }),
}));

/**
 * Doska tartibi: hali tugamaganlar birinchi, keyin boshlanish vaqti bo'yicha
 * yangidan eskiga.
 */
export function sortLiveCallRows(rows: LiveCallRow[]): LiveCallRow[] {
	return [...rows].sort((a, b) => {
		const aEnded = a.endedAtMs === null ? 0 : 1;
		const bEnded = b.endedAtMs === null ? 0 : 1;
		if (aEnded !== bEnded) {
			return aEnded - bEnded;
		}
		return Date.parse(b.startedAt) - Date.parse(a.startedAt);
	});
}

/**
 * MainLayout'dagi mavjud WebSocket ishlovchisidan chaqirish uchun ko'prik.
 * React hook emas, shuning uchun har qanday joydan chaqirilishi mumkin.
 */
export function handleLiveCallWsMessage(msg: WsMessage): void {
	useLiveCallsStore.getState().handleWsMessage(msg);
}
