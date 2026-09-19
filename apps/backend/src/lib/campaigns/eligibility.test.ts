/**
 * The eligibility rules ARE the safety argument, so they are tested on their own.
 *
 * Every case below is a way this feature could ring the wrong person, ring them
 * too often, ring them at night, or spin for ever without ringing anybody. None
 * of them needs a database, a clock or a phone.
 */
import { describe, expect, test } from "bun:test";

import type { CampaignStatus } from "@/db/schema";

import { planCampaignTick, type TickCounts, type TickInput } from "./eligibility";
import { describeWindow } from "./window";

const ZONE = "Asia/Tashkent";
/** 10:00 in Tashkent - inside a 09:00-18:00 window. */
const DAYTIME = new Date("2026-08-08T05:00:00.000Z");
/** 03:00 in Tashkent - the hour this whole feature exists to protect. */
const NIGHT = new Date("2026-08-07T22:00:00.000Z");

const WINDOW = { start: "09:00", end: "18:00" };

function counts(overrides: Partial<TickCounts> = {}): TickCounts {
	return {
		openLeads: 10,
		pendingReachable: 10,
		dueReachable: 10,
		campaignInFlight: 0,
		platformInFlight: 0,
		...overrides,
	};
}

function plan(overrides: Partial<TickInput> = {}, at: Date = DAYTIME) {
	const input: TickInput = {
		status: "running",
		telephonyRunning: true,
		window: describeWindow(WINDOW, ZONE, at),
		campaignConcurrency: 2,
		platformConcurrency: 3,
		counts: counts(),
		...overrides,
	};

	return planCampaignTick(input);
}

describe("the calling window", () => {
	test("a campaign started at 03:00 places nothing and says when it will", () => {
		const result = plan({}, NIGHT);

		expect(result.dial).toBe(0);
		expect(result.blocked).toBe("window_closed");
		// The message is the one the campaign page and the refused start both use, so
		// the operator is not told two different things about the same fact.
		expect(result.message).toContain("qo'ng'iroq vaqti emas");
		// NOT a halt: nothing is wrong, the morning simply has not arrived.
		expect(result.halt).toBe(false);
	});

	test("inside the window the queue is dialled", () => {
		const result = plan({}, DAYTIME);

		expect(result.blocked).toBeNull();
		expect(result.dial).toBeGreaterThan(0);
	});

	test("the window is evaluated in the tenant's zone, not the server's", () => {
		// 23:30 UTC is 04:30 the next morning in Tashkent: closed. The same instant in
		// London is inside a 09:00-18:00 day only if you read the wrong clock.
		const at = new Date("2026-08-07T23:30:00.000Z");

		expect(
			planCampaignTick({
				status: "running",
				telephonyRunning: true,
				window: describeWindow(WINDOW, ZONE, at),
				campaignConcurrency: 2,
				platformConcurrency: 3,
				counts: counts(),
			}).blocked
		).toBe("window_closed");
	});

	test("the end of the window is exclusive - 18:00 no longer dials", () => {
		// 13:00 UTC = 18:00 Tashkent.
		const at = new Date("2026-08-08T13:00:00.000Z");

		expect(plan({}, at).blocked).toBe("window_closed");
	});
});

describe("status transitions", () => {
	for (const status of ["draft", "paused", "finished", "cancelled"] as CampaignStatus[]) {
		test(`a ${status} campaign places no new calls`, () => {
			const result = plan({ status });

			expect(result.dial).toBe(0);
			expect(result.blocked).toBe("campaign_not_running");
			expect(result.halt).toBe(false);
		});
	}

	test("pausing does not abandon the calls already up", () => {
		// The plan says "claim nothing"; it says nothing about hanging anything up,
		// which is exactly the distinction. A paused campaign with two calls in flight
		// still reports them as in flight, so the concurrency budget stays honest.
		const result = plan({ status: "paused", counts: counts({ campaignInFlight: 2 }) });

		expect(result.dial).toBe(0);
		expect(result.blocked).toBe("campaign_not_running");
	});
});

describe("concurrency", () => {
	test("the campaign's own limit caps how many are claimed", () => {
		expect(plan({ campaignConcurrency: 2, counts: counts({ dueReachable: 50 }) }).dial).toBe(2);
	});

	test("calls already out count against the campaign limit", () => {
		const result = plan({ campaignConcurrency: 3, counts: counts({ campaignInFlight: 2 }) });

		expect(result.dial).toBe(1);
	});

	test("a full campaign limit dials nothing and does not halt", () => {
		const result = plan({ campaignConcurrency: 1, counts: counts({ campaignInFlight: 1 }) });

		expect(result.dial).toBe(0);
		expect(result.blocked).toBe("campaign_concurrency");
		expect(result.halt).toBe(false);
	});

	test("the platform limit caps a campaign that is under its own limit", () => {
		// This is the AI provider's quota, not the trunk's: every concurrent call is
		// one live voice session, and twenty at once is throttling.
		const result = plan({
			campaignConcurrency: 20,
			platformConcurrency: 3,
			counts: counts({ platformInFlight: 1 }),
		});

		expect(result.dial).toBe(2);
	});

	test("a full platform limit blocks even an idle campaign", () => {
		const result = plan({
			platformConcurrency: 3,
			counts: counts({ campaignInFlight: 0, platformInFlight: 3 }),
		});

		expect(result.dial).toBe(0);
		expect(result.blocked).toBe("platform_concurrency");
	});

	test("the smallest of the three ceilings wins", () => {
		expect(
			plan({
				campaignConcurrency: 5,
				platformConcurrency: 4,
				counts: counts({ dueReachable: 2 }),
			}).dial
		).toBe(2);
	});

	test("an over-committed platform never produces a negative dial count", () => {
		const result = plan({
			platformConcurrency: 2,
			counts: counts({ platformInFlight: 9 }),
		});

		expect(result.dial).toBe(0);
	});
});

describe("the attempt delay", () => {
	test("leads that exist but are not due yet dial nothing, and that is not a halt", () => {
		// retryPlan wrote next_attempt_at; the claim query filters on it; this is what
		// the tick sees afterwards. The campaign resumes itself with nobody doing
		// anything, which is why it must not be reported as broken.
		const result = plan({ counts: counts({ dueReachable: 0 }) });

		expect(result.dial).toBe(0);
		expect(result.blocked).toBe("nothing_due");
		expect(result.halt).toBe(false);
	});
});

describe("a campaign that cannot place a single call stops and says so", () => {
	test("every remaining lead unreachable on this deployment halts the campaign", () => {
		// The no-trunk case: a list of mobile numbers and SIP_TRUNK_HOST empty. Left
		// alone this would tick for ever, finding the same rows and dialling nothing.
		const result = plan({
			counts: counts({ openLeads: 400, pendingReachable: 0, dueReachable: 0 }),
		});

		expect(result.dial).toBe(0);
		expect(result.blocked).toBe("no_reachable_leads");
		expect(result.halt).toBe(true);
		expect(result.message).toContain("SIP_TRUNK_HOST");
	});

	test("it is reported at night too, rather than waiting until 09:00", () => {
		// The halt check sits above the window check on purpose: an owner who launches
		// an unreachable campaign at 22:00 learns now, not in eleven hours.
		const result = plan(
			{ counts: counts({ openLeads: 400, pendingReachable: 0, dueReachable: 0 }) },
			NIGHT
		);

		expect(result.blocked).toBe("no_reachable_leads");
		expect(result.halt).toBe(true);
	});

	test("calls still in flight are waited for before halting", () => {
		// Those calls can still produce outcomes, and one of them may put a reachable
		// lead back into the queue. Halting now would stop a campaign that is working.
		const result = plan({
			counts: counts({ openLeads: 3, pendingReachable: 0, dueReachable: 0, campaignInFlight: 1 }),
		});

		expect(result.halt).toBe(false);
		expect(result.blocked).toBe("nothing_due");
	});

	test("an empty queue is finished, not halted", () => {
		const result = plan({ counts: counts({ openLeads: 0, pendingReachable: 0, dueReachable: 0 }) });

		expect(result.blocked).toBe("queue_empty");
		expect(result.halt).toBe(false);
	});
});

describe("telephony down", () => {
	test("no calls are placed and no attempt is spent", () => {
		const result = plan({ telephonyRunning: false });

		expect(result.dial).toBe(0);
		expect(result.blocked).toBe("telephony_down");
		// Not a halt: the voice layer coming back should resume the campaign without a
		// human pressing anything.
		expect(result.halt).toBe(false);
	});

	test("it outranks the window, so a closed window is not blamed for an outage", () => {
		expect(plan({ telephonyRunning: false }, NIGHT).blocked).toBe("telephony_down");
	});
});
