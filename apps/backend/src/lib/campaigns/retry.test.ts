/**
 * The retry policy.
 *
 * Two things must never happen: a person who answered getting a second call, and a
 * no-answer being retried forever. Both are decided here.
 */
import { describe, expect, test } from "bun:test";

import { FINAL_OUTCOMES, RETRYABLE_OUTCOMES, retryPlan } from "./retry";

const NOW = new Date("2026-08-08T05:30:00.000Z");

function plan(attempts: number, outcome: Parameters<typeof retryPlan>[0]["outcome"]) {
	return retryPlan({ attempts, maxAttempts: 3, retryDelayMinutes: 60, outcome, now: NOW });
}

describe("a human's answer is final, whatever it was", () => {
	for (const outcome of FINAL_OUTCOMES) {
		test(`${outcome} is done, with no next attempt`, () => {
			const result = plan(1, outcome);

			expect(result.status).toBe("done");
			expect(result.nextAttemptAt).toBeNull();
			expect(result.retryable).toBe(false);
		});
	}

	test("even with attempts to spare, a refusal is not retried", () => {
		expect(plan(1, "refused").status).toBe("done");
		expect(plan(1, "refused").nextAttemptAt).toBeNull();
	});
});

describe("nobody reached: retried, but bounded", () => {
	for (const outcome of RETRYABLE_OUTCOMES) {
		test(`${outcome} on attempt 1 of 3 goes back into the queue`, () => {
			const result = plan(1, outcome);

			expect(result.status).toBe("pending");
			expect(result.retryable).toBe(true);
			expect(result.attemptsLeft).toBe(2);
			// Exactly the configured delay later, not immediately.
			expect(result.nextAttemptAt?.toISOString()).toBe("2026-08-08T06:30:00.000Z");
		});

		test(`${outcome} on the last attempt gives up as failed`, () => {
			const result = plan(3, outcome);

			expect(result.status).toBe("failed");
			expect(result.nextAttemptAt).toBeNull();
			expect(result.retryable).toBe(false);
			expect(result.attemptsLeft).toBe(0);
		});
	}

	test("the delay comes from the campaign, not from a constant", () => {
		const result = retryPlan({
			attempts: 1,
			maxAttempts: 2,
			retryDelayMinutes: 15,
			outcome: "no_answer",
			now: NOW,
		});

		expect(result.nextAttemptAt?.toISOString()).toBe("2026-08-08T05:45:00.000Z");
	});

	test("a campaign configured for one attempt never retries", () => {
		const result = retryPlan({
			attempts: 1,
			maxAttempts: 1,
			retryDelayMinutes: 60,
			outcome: "no_answer",
			now: NOW,
		});

		expect(result.status).toBe("failed");
		expect(result.nextAttemptAt).toBeNull();
	});

	test("attempts beyond the limit cannot produce a negative allowance", () => {
		expect(plan(9, "busy").attemptsLeft).toBe(0);
		expect(plan(9, "busy").status).toBe("failed");
	});
});

describe("the two outcomes that leave the queue for good", () => {
	test("«don't call me again» is skipped, not failed - nothing went wrong", () => {
		const result = plan(1, "do_not_call");

		expect(result.status).toBe("skipped");
		expect(result.nextAttemptAt).toBeNull();
	});

	test("an unusable number is failed and never retried", () => {
		// Retrying would fail identically every time.
		const result = plan(1, "invalid_number");

		expect(result.status).toBe("failed");
		expect(result.nextAttemptAt).toBeNull();
		expect(result.retryable).toBe(false);
	});
});
