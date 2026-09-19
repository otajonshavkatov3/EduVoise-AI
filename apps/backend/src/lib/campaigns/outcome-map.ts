// biome-ignore-all lint/style/useNamingConvention: both maps below are keyed by an enum whose members are snake_case on the wire and in Postgres - OutboundOutcome from the telephony layer and campaign_outcome from the database. Renaming the keys to camelCase would mean a lookup could no longer be written as map[outcome], which is the one thing that makes these tables exhaustive by type.

/**
 * One translation table between two outcome vocabularies that must stay apart.
 *
 * The telephony layer's `OutboundOutcome` is what a CALL produced: seven things
 * the agent can conclude from a conversation plus four the channel decides. The
 * `campaign_outcome` enum is what a BUSINESS reads off the campaign page. They
 * are nearly the same list, which is exactly why the two places they differ are
 * worth a file of their own rather than a ternary at the call site:
 *
 *   opt_out  -> do_not_call    The agent's word for "they asked never to be
 *                              rung again"; the database's word for the same
 *                              fact, and the value retryPlan keys the "leaves
 *                              the queue for good" branch off.
 *   voicemail -> no_answer     An answering machine picked up, so the PHONE
 *                              answered and the PERSON did not. There is no
 *                              voicemail value in the enum and adding one would
 *                              be an enum migration for a fact the business
 *                              cannot act on differently: what it wants is
 *                              another attempt at a human, which is precisely
 *                              what no_answer buys.
 *   call_back -> callback_requested   The same thing, spelled the way each side
 *                              spells it.
 *
 * Exhaustive by construction: the map is typed `Record<OutboundOutcome, ...>`,
 * so a new outcome added to the telephony layer stops this file compiling until
 * somebody decides what it means to a business, instead of falling through a
 * default to "failed" and quietly getting the person re-dialled.
 */
import type { CampaignOutcome } from "@/db/schema";
import type { OutboundOutcome } from "@/lib/telephony";

const OUTCOME_MAP: Record<OutboundOutcome, CampaignOutcome> = {
	// Conversation outcomes - a person said something.
	agreed: "agreed",
	call_back: "callback_requested",
	refused: "refused",
	opt_out: "do_not_call",
	wrong_person: "wrong_person",
	answered: "answered",
	voicemail: "no_answer",
	// Channel outcomes - nobody said anything.
	no_answer: "no_answer",
	busy: "busy",
	invalid_number: "invalid_number",
	failed: "failed",
};

/** What the campaign row records for what the call produced. */
export function toCampaignOutcome(outcome: OutboundOutcome): CampaignOutcome {
	return OUTCOME_MAP[outcome];
}

/** Uzbek labels for the note written onto the lead. Keyed to the DB vocabulary. */
const OUTCOME_LABELS: Record<CampaignOutcome, string> = {
	answered: "Suhbat bo'ldi",
	no_answer: "Javob bo'lmadi",
	busy: "Liniya band",
	invalid_number: "Raqam yaroqsiz",
	refused: "Rad etdi",
	agreed: "Rozi bo'ldi",
	callback_requested: "Keyinroq qo'ng'iroq qilishni so'radi",
	wrong_person: "Boshqa odam",
	do_not_call: "Boshqa qo'ng'iroq qilmaslikni so'radi",
	failed: "Qo'ng'iroq amalga oshmadi",
};

export function outcomeLabel(outcome: CampaignOutcome): string {
	return OUTCOME_LABELS[outcome];
}

/**
 * The one line a colleague reads on the lead row.
 *
 * The label alone is not enough ("Rad etdi" - why?) and the raw reason alone is
 * not enough (it is whatever the model or Asterisk said), so it is both. A
 * requested call-back time is appended in full rather than being turned into a
 * schedule: see the note on callback_requested in the dialer.
 */
export function buildLeadNote(
	outcome: CampaignOutcome,
	reason: string | null,
	callBackAt: string | null
): string {
	const parts = [outcomeLabel(outcome)];
	const detail = (reason ?? "").trim();

	if (detail.length > 0) {
		parts.push(detail);
	}

	if (callBackAt !== null && callBackAt.trim().length > 0) {
		parts.push(`So'ralgan vaqt: ${callBackAt.trim()}`);
	}

	return parts.join(" — ");
}
