// biome-ignore-all lint/style/useNamingConvention: the object keys asserted here are wire values - import skip reason codes and `campaign_outcome` enum members. They are snake_case in the API response and in Postgres, and a test has to spell them the way they actually arrive.

/**
 * The judgement the campaign endpoints make on top of the rows.
 *
 * The rules themselves are tested in lib/campaigns (transitions, window, retry,
 * phone, parser). What lives here is the reasoning the HTTP layer adds, and every one
 * of these has a wrong answer that would look plausible in review:
 *
 *   - whether a campaign can dial anything at all with no SIP trunk configured.
 *     Getting this wrong either blocks the only way to test the feature today, or
 *     lets somebody launch 500 rows that all fail.
 *   - the import's first pass: a malformed number and a duplicate inside one file,
 *     each with the reason the UI shows next to the row.
 *   - the progress folds, where a missing GROUP BY key must read as 0 and not as
 *     absent, and where cost-per-conversation must not be divided by no-answers.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { CampaignOutcome } from "@/db/schema";
import {
	countConversations,
	describeReadiness,
	foldLeadCounts,
	foldOutcomeCounts,
	trunkConfigured,
} from "./campaigns.handlers";
import { type Candidate, countByReason, screenCandidates } from "./campaigns.leads.handlers";

// ===========================================
// Dialing readiness
// ===========================================

const originalTrunk = process.env.SIP_TRUNK_HOST;

afterEach(() => {
	if (originalTrunk === undefined) {
		delete process.env.SIP_TRUNK_HOST;
	} else {
		process.env.SIP_TRUNK_HOST = originalTrunk;
	}
});

describe("dialing readiness with no SIP trunk", () => {
	test("this deployment has no trunk, which is the state the feature must handle", () => {
		// If this ever fails, a trunk was configured and the two branches below swap.
		expect(trunkConfigured()).toBe(false);
	});

	test("a campaign of mobile numbers cannot dial anything", () => {
		delete process.env.SIP_TRUNK_HOST;

		const readiness = describeReadiness({ external: 500, internal: 0 });

		expect(readiness.trunkConfigured).toBe(false);
		expect(readiness.canDial).toBe(false);
		expect(readiness.warning).toContain("SIP_TRUNK_HOST");
	});

	test("a campaign of internal extensions CAN dial - this is how the feature is tested", () => {
		delete process.env.SIP_TRUNK_HOST;

		const readiness = describeReadiness({ external: 0, internal: 4 });

		expect(readiness.canDial).toBe(true);
		expect(readiness.hasInternalLeads).toBe(true);
		// Still warned about, because the trunk is still missing.
		expect(readiness.warning).toContain("SIP_TRUNK_HOST");
	});

	test("a mixed list dials the extensions and says how many rows are skipped", () => {
		delete process.env.SIP_TRUNK_HOST;

		const readiness = describeReadiness({ external: 37, internal: 2 });

		expect(readiness.canDial).toBe(true);
		expect(readiness.warning).toContain("37 ta tashqi raqam");
	});

	test("an empty queue cannot dial, trunk or no trunk", () => {
		delete process.env.SIP_TRUNK_HOST;
		expect(describeReadiness({ external: 0, internal: 0 }).canDial).toBe(false);

		process.env.SIP_TRUNK_HOST = "sip.example.uz";
		expect(describeReadiness({ external: 0, internal: 0 }).canDial).toBe(false);
	});
});

describe("dialing readiness once a trunk exists", () => {
	test("mobile numbers become dialable and the warning goes away", () => {
		process.env.SIP_TRUNK_HOST = "sip.example.uz";

		const readiness = describeReadiness({ external: 500, internal: 0 });

		expect(readiness.trunkConfigured).toBe(true);
		expect(readiness.canDial).toBe(true);
		expect(readiness.warning).toBe("");
	});

	test("whitespace is not configuration", () => {
		process.env.SIP_TRUNK_HOST = "   ";
		expect(trunkConfigured()).toBe(false);
	});
});

// ===========================================
// Import: first pass
// ===========================================

function candidate(index: number, input: string, line: number | null = null): Candidate {
	return { index, line, input, fullName: null, variables: {}, note: null };
}

describe("import screening: per-row reasons, never a count", () => {
	test("a malformed number is skipped with the normaliser's own sentence", () => {
		const { accepted, results } = screenCandidates([candidate(0, "anonymous", 2)]);

		expect(accepted).toHaveLength(0);
		expect(results).toHaveLength(1);
		expect(results[0]?.status).toBe("skipped");
		expect(results[0]?.reason).toBe("invalid_number");
		expect(results[0]?.line).toBe(2);
		expect(results[0]?.phoneNumber).toBeNull();
		// The row it came from, so the owner can find it in their spreadsheet.
		expect(results[0]?.input).toBe("anonymous");
	});

	test("the same number twice in one file: the first survives, the second says which line", () => {
		const { accepted, results } = screenCandidates([
			candidate(0, "998905706507", 1),
			candidate(1, "+998 90 570 65 07", 2),
		]);

		expect(accepted).toHaveLength(1);
		expect(accepted[0]?.phoneNumber).toBe("998905706507");
		expect(results).toHaveLength(1);
		expect(results[0]?.reason).toBe("duplicate_in_file");
		expect(results[0]?.message).toContain("1-qator");
	});

	test("duplicates are detected AFTER normalisation, not on the raw text", () => {
		// "905706507" and "998905706507" are the same person - the whole reason the
		// stored form exists.
		const { accepted, results } = screenCandidates([
			candidate(0, "905706507"),
			candidate(1, "998905706507"),
		]);

		expect(accepted).toHaveLength(1);
		expect(results[0]?.reason).toBe("duplicate_in_file");
	});

	test("valid rows keep their name, variables and position", () => {
		const { accepted } = screenCandidates([
			{
				index: 3,
				line: 7,
				input: "90 570 65 07",
				fullName: "Alisher",
				variables: { qarz: "450000" },
				note: "eski mijoz",
			},
		]);

		expect(accepted).toHaveLength(1);
		expect(accepted[0]).toMatchObject({
			index: 3,
			line: 7,
			phoneNumber: "998905706507",
			fullName: "Alisher",
			variables: { qarz: "450000" },
			note: "eski mijoz",
		});
	});

	test("one bad row does not stop the rest - the point of the whole endpoint", () => {
		const { accepted, results } = screenCandidates([
			candidate(0, "998901234567", 1),
			candidate(1, "anonymous", 2),
			candidate(2, "998901234568", 3),
			candidate(3, "998901234567", 4),
			candidate(4, "12", 5),
		]);

		expect(accepted).toHaveLength(2);
		expect(results.map((row) => row.reason)).toEqual([
			"invalid_number",
			"duplicate_in_file",
			"invalid_number",
		]);
	});

	test("an extension imports as a lead, so the feature can be tested with no trunk", () => {
		const { accepted } = screenCandidates([candidate(0, "201")]);

		expect(accepted[0]?.phoneNumber).toBe("201");
	});
});

describe("countByReason", () => {
	test("every reason is present, so the UI never renders an undefined count", () => {
		const counts = countByReason([]);

		expect(counts).toEqual({
			invalid_number: 0,
			duplicate_in_file: 0,
			already_in_campaign: 0,
			do_not_call: 0,
			insert_failed: 0,
		});
	});

	test("counts group the rows the UI summarises", () => {
		const { results } = screenCandidates([
			candidate(0, "anonymous"),
			candidate(1, "998901234567"),
			candidate(2, "998901234567"),
		]);
		const counts = countByReason(results);

		expect(counts.invalid_number).toBe(1);
		expect(counts.duplicate_in_file).toBe(1);
		expect(counts.already_in_campaign).toBe(0);
	});
});

// ===========================================
// Progress folds
// ===========================================

describe("foldLeadCounts", () => {
	test("a status with no rows reads as 0, not as missing", () => {
		const counts = foldLeadCounts([{ status: "pending", value: 12 }]);

		expect(counts).toEqual({ total: 12, pending: 12, calling: 0, done: 0, failed: 0, skipped: 0 });
	});

	test("the total is the sum, not a separate query that can disagree", () => {
		const counts = foldLeadCounts([
			{ status: "pending", value: 5 },
			{ status: "done", value: 3 },
			{ status: "failed", value: 2 },
		]);

		expect(counts.total).toBe(10);
	});

	test("counts arriving as strings from the driver are still numbers", () => {
		// count() comes back as a string on some driver paths; "5" + "3" would be "53".
		const counts = foldLeadCounts([
			{ status: "pending", value: "5" },
			{ status: "done", value: "3" },
		]);

		expect(counts.total).toBe(8);
		expect(counts.pending).toBe(5);
	});
});

describe("foldOutcomeCounts", () => {
	test("every outcome key exists so the page renders a stable set of rows", () => {
		const counts = foldOutcomeCounts([]);

		expect(counts.answered).toBe(0);
		expect(counts.refused).toBe(0);
		expect(counts.do_not_call).toBe(0);
		expect(Object.keys(counts)).toHaveLength(10);
	});

	test("a null outcome group is ignored rather than counted as an outcome", () => {
		const counts = foldOutcomeCounts([
			{ outcome: null, value: 40 },
			{ outcome: "agreed", value: 2 },
		]);

		expect(counts.agreed).toBe(2);
	});
});

describe("countConversations", () => {
	function outcomes(
		overrides: Partial<Record<CampaignOutcome, number>>
	): Record<CampaignOutcome, number> {
		return foldOutcomeCounts(
			Object.entries(overrides).map(([outcome, value]) => ({
				outcome: outcome as CampaignOutcome,
				value: value ?? 0,
			}))
		);
	}

	test("only outcomes a person can produce are counted", () => {
		expect(
			countConversations(
				outcomes({
					answered: 3,
					agreed: 2,
					refused: 1,
					wrong_person: 1,
					callback_requested: 1,
					do_not_call: 1,
				})
			)
		).toBe(9);
	});

	test("a no-answer is not a conversation - it opens no AI session and costs nothing", () => {
		expect(countConversations(outcomes({ no_answer: 40, busy: 10, failed: 5 }))).toBe(0);
	});

	test("an invalid number is not a conversation either", () => {
		expect(countConversations(outcomes({ invalid_number: 7 }))).toBe(0);
	});
});
