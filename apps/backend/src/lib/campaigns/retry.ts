/**
 * The retry policy: what an outcome means for the queue.
 *
 * Pure and separate from the writer, because this is the rule a business actually
 * argues about ("ring them twice, an hour apart, then stop") and it has to be
 * readable and testable on its own. A no-answer is retried a bounded number of
 * times with a delay in between; a human's answer is never retried at all,
 * whatever that answer was.
 */
import type { CampaignLeadStatus, CampaignOutcome } from "@/db/schema";

/**
 * Outcomes where nobody was actually spoken to, so trying again is reasonable.
 *
 * `failed` is in the list because it is ours, not theirs: the originate did not
 * complete, which says nothing about whether the person would have picked up. The
 * attempt limit is what keeps that from becoming a loop.
 */
export const RETRYABLE_OUTCOMES: readonly CampaignOutcome[] = ["no_answer", "busy", "failed"];

/**
 * Outcomes that came out of a conversation with a person. Final, always: re-dialling
 * somebody who already refused is the behaviour that gets a business blocked.
 */
export const FINAL_OUTCOMES: readonly CampaignOutcome[] = [
	"answered",
	"agreed",
	"refused",
	"callback_requested",
	"wrong_person",
];

export interface RetryPlanInput {
	/** Attempts already made, INCLUDING the one that just produced `outcome`. */
	attempts: number;
	maxAttempts: number;
	retryDelayMinutes: number;
	outcome: CampaignOutcome;
	now?: Date;
}

export interface RetryPlan {
	status: CampaignLeadStatus;
	/** When the lead becomes dialable again, or null when it never does. */
	nextAttemptAt: Date | null;
	retryable: boolean;
	attemptsLeft: number;
}

const MS_PER_MINUTE = 60_000;

export function retryPlan(input: RetryPlanInput): RetryPlan {
	const now = input.now ?? new Date();
	const attemptsLeft = Math.max(0, input.maxAttempts - input.attempts);

	// The person asked not to be called. Not a failure and not a retry: the lead
	// leaves the queue, and do-not-call.ts makes sure no other campaign picks it up.
	if (input.outcome === "do_not_call") {
		return { status: "skipped", nextAttemptAt: null, retryable: false, attemptsLeft: 0 };
	}

	// The number itself is unusable. Retrying it would fail identically every time.
	if (input.outcome === "invalid_number") {
		return { status: "failed", nextAttemptAt: null, retryable: false, attemptsLeft: 0 };
	}

	if (FINAL_OUTCOMES.includes(input.outcome)) {
		return { status: "done", nextAttemptAt: null, retryable: false, attemptsLeft: 0 };
	}

	if (attemptsLeft > 0) {
		return {
			status: "pending",
			nextAttemptAt: new Date(now.getTime() + input.retryDelayMinutes * MS_PER_MINUTE),
			retryable: true,
			attemptsLeft,
		};
	}

	// Out of attempts. `failed` rather than `done`: nobody was reached, and a
	// business reading the summary needs those two counted apart.
	return { status: "failed", nextAttemptAt: null, retryable: false, attemptsLeft: 0 };
}
