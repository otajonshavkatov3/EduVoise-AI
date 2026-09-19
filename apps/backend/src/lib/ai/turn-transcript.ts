/**
 * One speaking turn's transcript, as a stream of fragments plus exactly one
 * final line.
 *
 * WHY THIS EXISTS
 *
 * A live call stored the agent greeting twice: once as a non-final interim row
 * and once as the final row. The duplication is structural, not a typo, and it
 * comes from how the two layers meet.
 *
 * The provider emits every `...audio_transcript.delta` as a non-final
 * transcript event. The orchestrator turns those into a per-role interim buffer
 * and persists that buffer through appendTranscript() whenever the deltas of one
 * turn keep arriving for longer than its write interval (2 s at the time of
 * writing). It then persists the final line as a second row when
 * `...audio_transcript.done` lands. appendTranscript() is a plain INSERT with no
 * "replace the interim row" path, and it is owned by another module, so nothing
 * downstream can collapse the pair.
 *
 * The result is two rows carrying the same sentence: a prefix of it, and it.
 * That is what this module prevents, on the provider side, in the only way that
 * is available from here - by not emitting the interim event that would become
 * the redundant row.
 *
 * HOW
 *
 * Model transcript deltas are not competing ASR hypotheses; they are a strict
 * prefix stream of text the model has already committed to. So an interim row is
 * never new information - it is always a shorter copy of the final line. This
 * stream therefore emits interim fragments only inside a short window at the
 * start of a turn (long enough for the live view to show speech immediately,
 * short enough that the consumer's interim write interval is never reached), and
 * after that stays quiet and lets the single final line carry the rest.
 *
 * The three guarantees the rest of the AI layer relies on:
 *
 *   1. Every turn that produced any text ends in exactly ONE final emission -
 *      including a turn cut short by barge-in, which is finalised by abandon().
 *      A turn that never finalises would leave the consumer's interim buffer
 *      live, and because that buffer is keyed by role alone, the next turn's
 *      text would be appended to the abandoned turn's text.
 *   2. No interim emission ever happens late enough in a turn to be persisted.
 *   3. Deltas that arrive after a turn was finalised (OpenAI keeps sending them
 *      for a moment after `response.cancel`) are dropped, so they cannot re-open
 *      a buffer that was already closed.
 *
 * Interim emissions are FRAGMENTS, not the accumulated text: the consumer
 * concatenates non-final content and replaces on final. Final emissions are the
 * whole line.
 */

/**
 * Interim fragments stop being emitted this long after a turn's first one.
 *
 * Must stay below the consumer's interim write interval
 * (INTERIM_WRITE_MIN_INTERVAL_MS in call-orchestrator.ts, 2 000 ms), because
 * that consumer persists an interim row on the first delta to arrive after the
 * interval has elapsed. 1 500 ms leaves 500 ms of headroom for event-loop lag,
 * and covers a short spoken turn end to end - the model generates a
 * two-sentence Uzbek turn in well under a second.
 */
export const DEFAULT_INTERIM_WINDOW_MS = 1_500;

/**
 * Smallest gap between two interim emissions. Matches the consumer's own
 * broadcast throttle (250 ms), so coalescing here costs the live view nothing
 * and saves a per-token round trip through the handler chain.
 */
export const DEFAULT_INTERIM_MIN_INTERVAL_MS = 250;

/** Longest text one turn may accumulate, matching the consumer's own cap. */
export const MAX_TURN_CHARS = 4_000;

/** How many finalised turn ids are remembered for the late-delta guard. */
const MAX_REMEMBERED_TURNS = 8;

export interface TurnTranscriptStreamOptions {
	/** Interim emissions stop this long after the first one. Default 1 500 ms. */
	interimWindowMs?: number;
	/** Minimum gap between interim emissions. Default 250 ms. */
	interimMinIntervalMs?: number;
	/** Character cap per turn. Default 4 000. */
	maxTurnChars?: number;
}

interface TurnState {
	/** Response id (agent) or item id (caller); null when the wire omitted it. */
	id: string | null;
	text: string;
	/** Text accumulated since the last interim emission. */
	pending: string;
	/** When the first interim fragment of this turn went out. */
	firstEmitAtMs: number | null;
	lastEmitAtMs: number;
}

function createTurnState(id: string | null): TurnState {
	return { id, text: "", pending: "", firstEmitAtMs: null, lastEmitAtMs: 0 };
}

/**
 * The transcript of one role's turns on one call.
 *
 * One instance per role - the agent's and the caller's turns interleave, and
 * they are finalised by different wire events.
 */
export class TurnTranscriptStream {
	private readonly interimWindowMs: number;
	private readonly interimMinIntervalMs: number;
	private readonly maxTurnChars: number;

	private turn: TurnState | null = null;

	/**
	 * Ids of turns already finalised, newest last. A Set is used as a small FIFO:
	 * insertion order is guaranteed, so the oldest entry is the first key.
	 */
	private readonly finalisedIds = new Set<string>();

	/**
	 * Set when a turn with no id was finalised. Without an id there is no way to
	 * tell a late delta of that turn from the first delta of the next one, so this
	 * flag only suppresses an immediate second final for the same turn.
	 */
	private finalisedAnonymous = false;

	constructor(options: TurnTranscriptStreamOptions = {}) {
		this.interimWindowMs = options.interimWindowMs ?? DEFAULT_INTERIM_WINDOW_MS;
		this.interimMinIntervalMs = options.interimMinIntervalMs ?? DEFAULT_INTERIM_MIN_INTERVAL_MS;
		this.maxTurnChars = options.maxTurnChars ?? MAX_TURN_CHARS;
	}

	/** Text accumulated for the turn in progress, or "" when none is open. */
	get currentText(): string {
		return this.turn?.text ?? "";
	}

	/** True when a turn is open and has produced text that is not final yet. */
	get hasOpenTurn(): boolean {
		return this.turn !== null && this.turn.text.trim().length > 0;
	}

	/**
	 * Take one transcript delta.
	 *
	 * @returns the fragment to emit as a non-final transcript event, or null when
	 *          this delta must not produce one (coalesced, past the interim
	 *          window, or belonging to a turn that is already finalised).
	 */
	pushDelta(id: string | null, delta: string, nowMs: number): string | null {
		if (delta.length === 0) {
			return null;
		}

		if (id !== null && this.finalisedIds.has(id)) {
			// A cancelled response keeps sending deltas for a moment. Its final line
			// has already been stored, so these would re-open a closed turn.
			return null;
		}

		const turn = this.openTurn(id);
		const room = this.maxTurnChars - turn.text.length;

		if (room <= 0) {
			return null;
		}

		const accepted = delta.length <= room ? delta : delta.slice(0, room);

		turn.text += accepted;
		turn.pending += accepted;

		return this.takeInterim(turn, nowMs);
	}

	/**
	 * Close the turn with the authoritative text from the wire.
	 *
	 * @param transcript the server's own full transcript for the turn; the
	 *        accumulated deltas are used when it is missing or empty.
	 * @returns the final line to emit, or null when this turn has already been
	 *          finalised or produced no text at all.
	 */
	finalise(id: string | null, transcript: string | null): string | null {
		if (id !== null && this.finalisedIds.has(id)) {
			return null;
		}

		const turn = this.turn;
		const wireText = (transcript ?? "").trim();

		if (turn === null) {
			// No deltas were seen for this turn. Normal: whisper-1 sends none at all,
			// so `.completed` is the only event a caller turn ever produces.
			if (id === null && this.finalisedAnonymous) {
				return null;
			}

			return this.closeWith(id, wireText);
		}

		const isDifferentTurn = id !== null && turn.id !== null && turn.id !== id;

		// Whichever turn this `.done` belongs to, the open one is closed here: a
		// turn left open would keep the consumer's role-keyed interim buffer alive
		// and the next turn's text would be appended to this one's.
		this.turn = null;

		if (isDifferentTurn) {
			this.remember(turn.id);
			return this.closeWith(id, wireText);
		}

		return this.closeWith(id ?? turn.id, wireText.length > 0 ? wireText : turn.text);
	}

	/**
	 * Close the turn in progress because the caller interrupted it.
	 *
	 * The text is what the model had produced by then, unchanged: it is the only
	 * record of what the agent was saying, and trimming it to guess how much the
	 * caller actually heard would be inventing a boundary.
	 *
	 * @returns the final line to emit, or null when there is nothing open.
	 */
	abandon(): string | null {
		const turn = this.turn;

		if (turn === null) {
			return null;
		}

		this.turn = null;

		return this.closeWith(turn.id, turn.text);
	}

	/** Forget everything. Used when the session is torn down or reconnects. */
	reset(): void {
		this.turn = null;
		this.finalisedIds.clear();
		this.finalisedAnonymous = false;
	}

	// -----------------------------------------
	// Internals
	// -----------------------------------------

	/** The open turn for `id`, starting a new one when the turn has changed. */
	private openTurn(id: string | null): TurnState {
		const turn = this.turn;

		if (turn === null) {
			const started = createTurnState(id);
			this.turn = started;
			return started;
		}

		if (id !== null && turn.id !== null && turn.id !== id) {
			// A new response started without the previous one being finalised. The
			// provider finalises on cancel, so reaching here means the wire skipped a
			// `.done`; the previous text is dropped rather than glued onto a
			// different turn.
			this.remember(turn.id);

			const started = createTurnState(id);
			this.turn = started;
			return started;
		}

		if (turn.id === null && id !== null) {
			// The first delta of the turn arrived without an id and a later one has
			// it: adopt it, so the finalised-id guard can work for this turn.
			turn.id = id;
		}

		return turn;
	}

	/**
	 * Decide whether the pending fragment may go out now.
	 *
	 * The first fragment of a turn always goes out immediately - that is what
	 * makes the live view feel live. After that, emissions are throttled, and
	 * once the interim window has passed nothing more is emitted for this turn.
	 */
	private takeInterim(turn: TurnState, nowMs: number): string | null {
		if (turn.pending.length === 0) {
			return null;
		}

		if (turn.firstEmitAtMs === null) {
			turn.firstEmitAtMs = nowMs;
			return this.flushInterim(turn, nowMs);
		}

		if (nowMs - turn.firstEmitAtMs >= this.interimWindowMs) {
			return null;
		}

		if (nowMs - turn.lastEmitAtMs < this.interimMinIntervalMs) {
			return null;
		}

		return this.flushInterim(turn, nowMs);
	}

	private flushInterim(turn: TurnState, nowMs: number): string {
		const fragment = turn.pending;

		turn.pending = "";
		turn.lastEmitAtMs = nowMs;

		return fragment;
	}

	/** Record the turn as finalised and return its line, or null when empty. */
	private closeWith(id: string | null, text: string): string | null {
		this.remember(id);

		const content = text.trim().slice(0, this.maxTurnChars).trim();

		return content.length === 0 ? null : content;
	}

	private remember(id: string | null): void {
		if (id === null) {
			this.finalisedAnonymous = true;
			return;
		}

		this.finalisedAnonymous = false;
		this.finalisedIds.add(id);

		while (this.finalisedIds.size > MAX_REMEMBERED_TURNS) {
			const oldest = this.finalisedIds.values().next();

			if (oldest.done === true) {
				break;
			}

			this.finalisedIds.delete(oldest.value);
		}
	}
}
