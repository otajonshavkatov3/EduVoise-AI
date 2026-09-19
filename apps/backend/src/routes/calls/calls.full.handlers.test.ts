/**
 * The judgement calls inside GET /calls/{id}/full.
 *
 * The joins themselves are exercised over HTTP in tests/integration/call-full.test.ts,
 * against a real database. What lives here is the reasoning the endpoint does on
 * top of the rows - the places where a wrong answer would be plausible enough to
 * ship:
 *
 *   - a recording that exists only as `calls.recording_path`, with no
 *     `call_recordings` row. Dropping it would silently un-play every call the
 *     browser softphone recorded.
 *   - a name where a uuid used to be.
 *   - a call that never ran an AI session, which must price as "not known"
 *     rather than as free.
 */
import { describe, expect, test } from "bun:test";

import {
	type AnalysisTokenColumns,
	costDurationMs,
	countActions,
	displayName,
	isOverdue,
	recordingFileName,
	recordingUrl,
	type SessionTokenColumns,
	secondsBetween,
	toAnalysisTokens,
	toRecordings,
	toSessionTokens,
	toTranscriptLine,
} from "./calls.full.handlers";

// ===========================================
// Fixtures
// ===========================================

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ANALYSIS_ID = "33333333-3333-4333-8333-333333333333";
const RECORDING_ID = "44444444-4444-4444-8444-444444444444";

function recordingRow(overrides: Record<string, unknown> = {}) {
	return {
		id: RECORDING_ID,
		filePath: `/var/spool/asterisk/recordings/${CALL_ID}.wav`,
		fileName: `${CALL_ID}.wav`,
		format: "wav",
		sizeBytes: 512_000,
		durationSeconds: 254,
		isAvailable: true,
		createdAt: new Date("2026-08-07T03:30:00.000Z"),
		...overrides,
	};
}

function sessionColumns(overrides: Partial<SessionTokenColumns> = {}): SessionTokenColumns {
	return {
		sessionId: SESSION_ID,
		sessionPromptTokens: 220_980,
		sessionCompletionTokens: 3949,
		sessionCachedPromptTokens: 0,
		sessionCachedAudioTokens: null,
		sessionCachedTextTokens: null,
		sessionInputTextTokens: 159_690,
		sessionInputAudioTokens: 48_018,
		sessionOutputTextTokens: 0,
		sessionOutputAudioTokens: 3901,
		sessionTranscribeAudioTokens: 0,
		sessionTranscribeTextTokens: 0,
		...overrides,
	};
}

function analysisColumns(overrides: Partial<AnalysisTokenColumns> = {}): AnalysisTokenColumns {
	return {
		analysisId: ANALYSIS_ID,
		analysisPromptTokens: 40_000,
		analysisCachedPromptTokens: 10_000,
		analysisCompletionTokens: 2000,
		analysisBilledRuns: 2,
		...overrides,
	};
}

// ===========================================
// Names, not ids
// ===========================================

describe("displayName", () => {
	test("prefers the username", () => {
		expect(displayName("dispatcher", "+998900000001")).toBe("dispatcher");
	});

	test("falls back to the phone when there is no username", () => {
		expect(displayName(null, "+998900000001")).toBe("+998900000001");
		expect(displayName("   ", "+998900000001")).toBe("+998900000001");
	});

	test("never returns an empty label", () => {
		// The label is rendered as-is; an empty string would look like a broken row.
		expect(displayName(null, null)).toBe("Noma'lum");
		expect(displayName("", "")).toBe("Noma'lum");
	});
});

// ===========================================
// Recording
// ===========================================

describe("recordingUrl", () => {
	test("reduces an Asterisk container path to the file the API serves", () => {
		expect(recordingUrl("/var/spool/asterisk/recordings/abc.wav")).toBe(
			"/uploads/call-recordings/abc.wav"
		);
	});

	test("leaves an upload path alone", () => {
		expect(recordingUrl("/uploads/call-recordings/abc.webm")).toBe(
			"/uploads/call-recordings/abc.webm"
		);
	});

	test("passes an absolute URL through untouched", () => {
		expect(recordingUrl("https://cdn.example.com/abc.mp3")).toBe("https://cdn.example.com/abc.mp3");
	});

	test("handles a Windows-style path", () => {
		expect(recordingUrl("C:\\recordings\\abc.wav")).toBe("/uploads/call-recordings/abc.wav");
	});
});

describe("recordingFileName", () => {
	test("takes the last segment of either separator", () => {
		expect(recordingFileName("/a/b/c.wav")).toBe("c.wav");
		expect(recordingFileName("a\\b\\c.wav")).toBe("c.wav");
		expect(recordingFileName("c.wav")).toBe("c.wav");
	});
});

describe("toRecordings", () => {
	test("maps the call_recordings rows when there are any", () => {
		const [recording] = toRecordings([recordingRow()], null);

		expect(recording?.id).toBe(RECORDING_ID);
		expect(recording?.url).toBe(`/uploads/call-recordings/${CALL_ID}.wav`);
		expect(recording?.durationSeconds).toBe(254);
	});

	test("keeps every file, because a transfer can produce a second one", () => {
		const rows = [recordingRow(), recordingRow({ id: SESSION_ID, fileName: "second.wav" })];

		expect(toRecordings(rows, null)).toHaveLength(2);
	});

	test("falls back to calls.recording_path when no row was ever written", () => {
		// The legacy FreePBX call-end webhook sets the column and inserts nothing.
		// Without this fallback every browser-recorded call loses its player.
		const [recording] = toRecordings([], "/uploads/call-recordings/browser.webm");

		expect(recording?.id).toBeNull();
		expect(recording?.fileName).toBe("browser.webm");
		expect(recording?.format).toBe("webm");
		expect(recording?.url).toBe("/uploads/call-recordings/browser.webm");
		expect(recording?.createdAt).toBeNull();
	});

	test("does not invent a duration for the fallback row", () => {
		const [recording] = toRecordings([], "/var/spool/asterisk/recordings/x.wav");

		expect(recording?.durationSeconds).toBeNull();
		expect(recording?.sizeBytes).toBeNull();
	});

	test("no rows and no path is no recording", () => {
		expect(toRecordings([], null)).toEqual([]);
	});

	test("a row wins over the column", () => {
		const recordings = toRecordings([recordingRow()], "/uploads/call-recordings/stale.webm");

		expect(recordings).toHaveLength(1);
		expect(recordings[0]?.id).toBe(RECORDING_ID);
	});
});

// ===========================================
// Durations
// ===========================================

describe("secondsBetween", () => {
	test("rounds to whole seconds", () => {
		expect(
			secondsBetween(new Date("2026-08-07T03:00:00.000Z"), new Date("2026-08-07T03:00:04.400Z"))
		).toBe(4);
	});

	test("is null when either end is missing", () => {
		expect(secondsBetween(null, new Date())).toBeNull();
		expect(secondsBetween(new Date(), null)).toBeNull();
	});

	test("refuses a negative gap rather than reporting a negative duration", () => {
		expect(
			secondsBetween(new Date("2026-08-07T03:00:05.000Z"), new Date("2026-08-07T03:00:00.000Z"))
		).toBeNull();
	});
});

describe("costDurationMs", () => {
	test("prefers the session's own measurement", () => {
		// calls.duration also counts ringing and the scripted greeting, which no
		// model was billed for.
		expect(costDurationMs(254_493, 300)).toBe(254_493);
	});

	test("falls back to the call duration in seconds", () => {
		expect(costDurationMs(null, 300)).toBe(300_000);
		expect(costDurationMs(0, 300)).toBe(300_000);
	});

	test("is null when neither is usable", () => {
		expect(costDurationMs(null, null)).toBeNull();
		expect(costDurationMs(null, 0)).toBeNull();
	});
});

describe("isOverdue", () => {
	const now = new Date("2026-08-07T12:00:00.000Z");

	test("an open task past its due date is overdue", () => {
		expect(isOverdue(new Date("2026-08-06T12:00:00.000Z"), "open", now)).toBe(true);
		expect(isOverdue(new Date("2026-08-06T12:00:00.000Z"), "in_progress", now)).toBe(true);
	});

	test("a finished task is not overdue however late it was", () => {
		expect(isOverdue(new Date("2026-08-06T12:00:00.000Z"), "done", now)).toBe(false);
		expect(isOverdue(new Date("2026-08-06T12:00:00.000Z"), "cancelled", now)).toBe(false);
	});

	test("no due date is not overdue", () => {
		expect(isOverdue(null, "open", now)).toBe(false);
	});
});

// ===========================================
// Transcript line
// ===========================================

describe("toTranscriptLine", () => {
	test("serialises the timestamp and keeps the ids the edit endpoints need", () => {
		const line = toTranscriptLine({
			id: RECORDING_ID,
			callId: CALL_ID,
			aiSessionId: SESSION_ID,
			role: "caller",
			content: "Assalomu alaykum",
			startMs: 1200,
			endMs: 3400,
			isFinal: true,
			confidence: null,
			createdAt: new Date("2026-08-07T03:26:30.000Z"),
		});

		// PATCH /transcripts/{id} is addressed by this id, so losing it would make
		// the transcript read-only on the merged page.
		expect(line.id).toBe(RECORDING_ID);
		expect(line.callId).toBe(CALL_ID);
		expect(line.aiSessionId).toBe(SESSION_ID);
		expect(line.createdAt).toBe("2026-08-07T03:26:30.000Z");
	});
});

// ===========================================
// Pricing inputs
// ===========================================

describe("toSessionTokens", () => {
	test("passes the counters through, nulls included", () => {
		const tokens = toSessionTokens(sessionColumns());

		expect(tokens.promptTokens).toBe(220_980);
		expect(tokens.inputAudioTokens).toBe(48_018);
		// Gemini does not report the cached modality split; null must survive so the
		// pricer apportions instead of trusting a fabricated zero.
		expect(tokens.cachedAudioTokens).toBeNull();
	});

	test("a call with no session reports nothing rather than zero", () => {
		// Zero would price as free. Null prices as "not known", which is the truth.
		const tokens = toSessionTokens(sessionColumns({ sessionId: null }));

		expect(tokens.promptTokens).toBeNull();
		expect(tokens.completionTokens).toBeNull();
		expect(tokens.cachedPromptTokens).toBeNull();
	});
});

describe("toAnalysisTokens", () => {
	test("returns the counters when the call was analysed", () => {
		expect(toAnalysisTokens(analysisColumns())).toEqual({
			promptTokens: 40_000,
			cachedPromptTokens: 10_000,
			completionTokens: 2000,
			billedRuns: 2,
		});
	});

	test("no analysis row is null, not a row of zeroes", () => {
		expect(toAnalysisTokens(analysisColumns({ analysisId: null }))).toBeNull();
	});

	test("an analysed call that never called the API keeps billedRuns 0", () => {
		// priceAnalysis reads 0 runs as unknown; that distinction is made there, not
		// here, so this mapping must not smuggle in a substitute.
		expect(toAnalysisTokens(analysisColumns({ analysisBilledRuns: 0 }))?.billedRuns).toBe(0);
	});
});

// ===========================================
// Action counts
// ===========================================

describe("countActions", () => {
	const empty = {
		ticket: null,
		transfers: [],
		followUps: [],
		bookings: [],
		notes: [],
	};

	test("counts nothing when nothing happened", () => {
		expect(countActions(empty)).toEqual({
			tickets: 0,
			transfers: 0,
			followUps: 0,
			bookings: 0,
			notes: 0,
		});
	});

	test("a ticket counts once - a call carries at most one", () => {
		const counts = countActions({
			...empty,
			ticket: {
				id: ANALYSIS_ID,
				subject: "Buyurtma",
				description: "...",
				category: null,
				priority: "medium" as const,
				status: "new" as const,
				externalRefId: null,
				createdAt: "2026-08-07T03:00:00.000Z",
				closedAt: null,
			},
		});

		expect(counts.tickets).toBe(1);
	});
});
