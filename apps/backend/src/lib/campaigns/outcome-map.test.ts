/**
 * The bridge between what a call produced and what a business reads.
 *
 * Tested exhaustively over OUTBOUND_OUTCOMES rather than case by case: the risk
 * this file carries is not a wrong mapping, it is a MISSING one - a new outcome
 * arriving from the telephony layer and falling through to something that gets
 * the person re-dialled.
 */
import { describe, expect, test } from "bun:test";

import { campaignOutcomeEnum } from "@/db/schema";
import { OUTBOUND_OUTCOMES } from "@/lib/telephony";
import { buildLeadNote, outcomeLabel, toCampaignOutcome } from "./outcome-map";
import { FINAL_OUTCOMES, RETRYABLE_OUTCOMES } from "./retry";

describe("every outcome the call path can produce has a home in the enum", () => {
	for (const outcome of OUTBOUND_OUTCOMES) {
		test(`${outcome} maps to a real campaign_outcome value`, () => {
			const mapped = toCampaignOutcome(outcome);

			expect(campaignOutcomeEnum.enumValues).toContain(mapped);
			// And it has a label, or the lead note would read as an empty string.
			expect(outcomeLabel(mapped).length).toBeGreaterThan(0);
		});
	}
});

describe("the two translations that are not the identity", () => {
	test("«opt_out» becomes «do_not_call» - the value that leaves the queue for good", () => {
		const mapped = toCampaignOutcome("opt_out");

		expect(mapped).toBe("do_not_call");
		// Neither retryable nor "final" in retry.ts's sense: it has its own branch that
		// skips the lead. Asserted here because mapping it to `refused` would look
		// identical on the page and would leave the number dialable by other campaigns.
		expect(RETRYABLE_OUTCOMES).not.toContain(mapped);
	});

	test("«voicemail» becomes «no_answer», so another attempt at a human is made", () => {
		const mapped = toCampaignOutcome("voicemail");

		expect(mapped).toBe("no_answer");
		expect(RETRYABLE_OUTCOMES).toContain(mapped);
	});

	test("«call_back» becomes «callback_requested» and is never retried automatically", () => {
		const mapped = toCampaignOutcome("call_back");

		expect(mapped).toBe("callback_requested");
		expect(FINAL_OUTCOMES).toContain(mapped);
	});
});

describe("what a human answered is never retried", () => {
	for (const outcome of ["agreed", "refused", "wrong_person", "answered"] as const) {
		test(`${outcome} maps to a final outcome`, () => {
			expect(FINAL_OUTCOMES).toContain(toCampaignOutcome(outcome));
		});
	}
});

describe("what nobody answered is retried", () => {
	for (const outcome of ["no_answer", "busy", "failed"] as const) {
		test(`${outcome} maps to a retryable outcome`, () => {
			expect(RETRYABLE_OUTCOMES).toContain(toCampaignOutcome(outcome));
		});
	}

	test("an unusable number is not retryable, however many attempts are left", () => {
		expect(RETRYABLE_OUTCOMES).not.toContain(toCampaignOutcome("invalid_number"));
	});
});

describe("the lead note a colleague actually reads", () => {
	test("carries the label and the reason", () => {
		expect(buildLeadNote("refused", "hozir qiziqmayman dedi", null)).toBe(
			"Rad etdi — hozir qiziqmayman dedi"
		);
	});

	test("a missing reason leaves the label alone rather than a dangling dash", () => {
		expect(buildLeadNote("no_answer", null, null)).toBe("Javob bo'lmadi");
		expect(buildLeadNote("no_answer", "   ", null)).toBe("Javob bo'lmadi");
	});

	test("a requested call-back time is kept in full, because a human acts on it", () => {
		const note = buildLeadNote(
			"callback_requested",
			"kechqurun so'radi",
			"2026-08-08T18:00:00+05:00"
		);

		expect(note).toContain("2026-08-08T18:00:00+05:00");
		expect(note).toContain("Keyinroq qo'ng'iroq qilishni so'radi");
	});
});
