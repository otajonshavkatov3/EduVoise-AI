/**
 * The seam module: the dial string, the outcome vocabulary and the dialer hooks.
 *
 * Four properties are pinned here, and each one is a thing that would be
 * expensive to discover on a live campaign rather than in a test run:
 *
 *   configuration  the dial string comes from a SETTING, so connecting a carrier
 *                  is an edit on a page and not a release. A pattern that lost
 *                  its {number} token would otherwise dial every lead in a list
 *                  at the same endpoint.
 *   retry policy   a hangup cause is read into an outcome, and the difference
 *                  between "busy" and "the number does not exist" is the whole
 *                  difference between trying again this afternoon and never.
 *   fail closed    a do-not-call check that throws must stop the dial. The
 *                  opposite default would ring the one person who asked us not
 *                  to, on the day the campaign tables had a bad deploy.
 *   honesty        an opt-out that could not be stored reports FALSE, so the
 *                  agent never claims a promise the platform did not keep.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { asTenantId } from "@shared/types";
import { OUTBOUND_CALL_OUTCOMES } from "@/lib/ai/tools";
import {
	classifyHangupCause,
	DIAL_PATTERN_TOKEN,
	isDoNotCallNumber,
	isOptOutOutcome,
	OUTBOUND_CHANNEL_OUTCOMES,
	OUTBOUND_OUTCOMES,
	type OutboundOptOutEntry,
	reportOutboundOptOut,
	reportOutboundOutcome,
	resolveOutboundCampaignKind,
	resolveOutboundEndpoint,
	setOutboundDialerHooks,
	toDialableDigits,
	trunkFromDialPattern,
} from "./outbound";

// The hooks live on globalThis so a hot reload cannot lose them, which means a
// test that registers them has to put them back.
afterEach(() => {
	setOutboundDialerHooks(null);
});

/**
 * A tenant id for the hooks and requests under test.
 *
 * These tests never touch the database, so the value only has to be a valid
 * branded id - what matters is that it is THREADED: the do-not-call check and the
 * opt-out write are per tenant now, and a hook that ignored the tenant would let
 * one customer's opt-out silence another customer's list.
 */
const TENANT = asTenantId("00000000-0000-0000-0000-0000000000aa");

const OPT_OUT: OutboundOptOutEntry = {
	tenantId: TENANT,
	phone: "998901234567",
	reason: "Boshqa qo'ng'iroq qilmang",
	callId: "11111111-1111-4111-8111-111111111111",
	campaignId: null,
	leadId: null,
	at: "2026-08-06T10:00:00.000+05:00",
};

// ===========================================
// The dial string
// ===========================================

describe("resolveOutboundEndpoint", () => {
	test("substitutes the digits into the configured pattern", () => {
		expect(resolveOutboundEndpoint("101", `PJSIP/${DIAL_PATTERN_TOKEN}`)).toEqual({
			endpoint: "PJSIP/101",
			digits: "101",
		});
	});

	test("strips everything that is not a digit before dialling", () => {
		// Leads arrive from spreadsheets: "+998 90 123-45-67" is a normal cell.
		expect(resolveOutboundEndpoint("+998 90 123-45-67", `PJSIP/${DIAL_PATTERN_TOKEN}`)).toEqual({
			endpoint: "PJSIP/998901234567",
			digits: "998901234567",
		});
	});

	test("routes through a trunk with no code change - only the pattern differs", () => {
		// The whole promise of making this a setting: the day a carrier is bought,
		// this string changes on the AI assistant page and nothing else moves.
		expect(resolveOutboundEndpoint("998901234567", `PJSIP/${DIAL_PATTERN_TOKEN}@trunk`)).toEqual({
			endpoint: "PJSIP/998901234567@trunk",
			digits: "998901234567",
		});
	});

	test("refuses a number too short or too long to be one", () => {
		expect(resolveOutboundEndpoint("12", `PJSIP/${DIAL_PATTERN_TOKEN}`)).toBeNull();
		expect(resolveOutboundEndpoint("1".repeat(21), `PJSIP/${DIAL_PATTERN_TOKEN}`)).toBeNull();
		expect(resolveOutboundEndpoint("", `PJSIP/${DIAL_PATTERN_TOKEN}`)).toBeNull();
		// Punctuation only: a spreadsheet cell holding "-" is not a phone number.
		expect(resolveOutboundEndpoint("---", `PJSIP/${DIAL_PATTERN_TOKEN}`)).toBeNull();
	});

	test("refuses a pattern with no token rather than dialling one endpoint for everybody", () => {
		// A hand-written override that lost its {number} would otherwise send every
		// lead in the list to the same phone.
		expect(resolveOutboundEndpoint("101", "PJSIP/trunk")).toBeNull();
	});
});

describe("trunkFromDialPattern", () => {
	test("reads the endpoint after the @, and null when there is none", () => {
		expect(trunkFromDialPattern(`PJSIP/${DIAL_PATTERN_TOKEN}@my-carrier`)).toBe("my-carrier");
		expect(trunkFromDialPattern(`PJSIP/${DIAL_PATTERN_TOKEN}`)).toBeNull();
		expect(trunkFromDialPattern(`PJSIP/${DIAL_PATTERN_TOKEN}@`)).toBeNull();
	});
});

describe("toDialableDigits", () => {
	test("keeps digits only", () => {
		expect(toDialableDigits("+998 (90) 123-45-67")).toBe("998901234567");
	});
});

// ===========================================
// Hangup causes
// ===========================================

describe("classifyHangupCause", () => {
	test("tells apart the causes a retry policy has to treat differently", () => {
		expect(classifyHangupCause(17).outcome).toBe("busy");
		expect(classifyHangupCause(19).outcome).toBe("no_answer");
		expect(classifyHangupCause(1).outcome).toBe("invalid_number");
		expect(classifyHangupCause(34).outcome).toBe("failed");
	});

	test("reads an unstated cause on a dial that rang out as a no-answer", () => {
		// Measured, not assumed: PJSIP/101 rung for 8 s with nobody picking up reports
		// cause 0. Left as "failed" it would tell the dialer the platform broke, and
		// hide a perfectly ordinary missed call from the retry policy.
		const verdict = classifyHangupCause(0, "Unknown");

		expect(verdict.outcome).toBe("no_answer");
		// The raw cause survives in the text for whoever is reading a support ticket.
		expect(verdict.reason).toContain("cause 0");
	});

	test("reads a rejected call as a no-answer, never as a refusal", () => {
		// "Refused" in this vocabulary means a person said no in words. Somebody
		// pressing the red button has told us only that they were not available, and
		// filing it as a refusal would both overstate what we know and hide the lead
		// from the retry policy for good.
		expect(classifyHangupCause(21).outcome).toBe("no_answer");
	});

	test("treats an unknown cause as a retryable failure and keeps the raw code", () => {
		const verdict = classifyHangupCause(255, "Something new");

		expect(verdict.outcome).toBe("failed");
		expect(verdict.reason).toContain("255");
		expect(verdict.reason).toContain("Something new");
	});

	test("always explains itself in Uzbek for the campaign page", () => {
		expect(classifyHangupCause(17).reason).toContain("Liniya band");
	});
});

// ===========================================
// The outcome vocabulary
// ===========================================

describe("the outcome vocabulary", () => {
	test("is the union of what a person can say and what the channel can decide", () => {
		expect(OUTBOUND_OUTCOMES).toEqual([...OUTBOUND_CALL_OUTCOMES, ...OUTBOUND_CHANNEL_OUTCOMES]);
	});

	test("keeps the conversation and channel sets disjoint", () => {
		// The model never heard a busy tone, so offering it "busy" would let it report
		// a no-answer on a call it just held a conversation on.
		for (const channelOutcome of OUTBOUND_CHANNEL_OUTCOMES) {
			expect(OUTBOUND_CALL_OUTCOMES as readonly string[]).not.toContain(channelOutcome);
		}
	});

	test("marks exactly one outcome as the one with teeth", () => {
		const withTeeth = OUTBOUND_OUTCOMES.filter((outcome) => isOptOutOutcome(outcome));

		expect(withTeeth).toEqual(["opt_out"]);
	});
});

describe("resolveOutboundCampaignKind", () => {
	test("accepts the spellings a dashboard actually stores", () => {
		expect(resolveOutboundCampaignKind("sales")).toBe("sales");
		expect(resolveOutboundCampaignKind("Follow-Up")).toBe("reminder");
		expect(resolveOutboundCampaignKind("follow_up")).toBe("reminder");
		expect(resolveOutboundCampaignKind("reklama")).toBe("advertising");
		expect(resolveOutboundCampaignKind("so'rovnoma")).toBe("survey");
	});

	test("never throws on a value this build has not heard of", () => {
		// A campaign row written by a newer dashboard must still be dialable, rather
		// than failing at the last moment with the person's phone already ringing.
		expect(resolveOutboundCampaignKind("something-new")).toBe("other");
		expect(resolveOutboundCampaignKind(null)).toBe("other");
		expect(resolveOutboundCampaignKind(undefined)).toBe("other");
	});
});

// ===========================================
// The guardrail
// ===========================================

describe("isDoNotCallNumber", () => {
	test("passes the number through to the registered check", async () => {
		const asked: string[] = [];

		setOutboundDialerHooks({
			isDoNotCall(tenantId, phone) {
				expect(tenantId).toBe(TENANT);
				asked.push(phone);
				return phone === "998901234567";
			},
		});

		expect(await isDoNotCallNumber(TENANT, "998901234567")).toBe(true);
		expect(await isDoNotCallNumber(TENANT, "998907654321")).toBe(false);
		expect(asked).toEqual(["998901234567", "998907654321"]);
	});

	test("FAILS CLOSED when the check throws", async () => {
		// The most important line in this file. A campaign that stops because the
		// check is broken costs the owner a delay; a campaign that dials through a
		// broken check costs them the one promise this feature makes.
		setOutboundDialerHooks({
			isDoNotCall() {
				throw new Error("the campaign tables are mid-migration");
			},
		});

		expect(await isDoNotCallNumber(TENANT, "998901234567")).toBe(true);
	});

	test("does not block dialling when no dialer is registered at all", async () => {
		// With nothing registered this layer cannot enforce the list and must not
		// pretend to - that is what the warning it logs is for. This is the state the
		// whole test suite and an internal test call run in.
		setOutboundDialerHooks(null);

		expect(await isDoNotCallNumber(TENANT, "998901234567")).toBe(false);
	});
});

describe("reportOutboundOptOut", () => {
	test("reports true only when the number really was stored", async () => {
		const stored: string[] = [];

		setOutboundDialerHooks({
			addToDoNotCall(entry) {
				stored.push(entry.phone);
			},
		});

		expect(await reportOutboundOptOut(OPT_OUT)).toBe(true);
		expect(stored).toEqual(["998901234567"]);
	});

	test("reports false when the write throws, instead of swallowing it", async () => {
		// The agent tells the person "you will not be called again" off the back of
		// this answer. Returning true here would make the platform a liar.
		setOutboundDialerHooks({
			addToDoNotCall() {
				throw new Error("unique violation");
			},
		});

		expect(await reportOutboundOptOut(OPT_OUT)).toBe(false);
	});

	test("reports false when nothing is registered to store it", async () => {
		setOutboundDialerHooks(null);

		expect(await reportOutboundOptOut(OPT_OUT)).toBe(false);
	});
});

describe("reportOutboundOutcome", () => {
	test("never throws when the campaign side does", async () => {
		// This runs inside call teardown. A dialer whose own write fails must not also
		// take down the teardown that was reporting to it.
		setOutboundDialerHooks({
			recordOutcome() {
				throw new Error("deadlock detected");
			},
		});

		await reportOutboundOutcome({
			callId: OPT_OUT.callId,
			campaignId: null,
			leadId: null,
			phone: OPT_OUT.phone,
			outcome: "answered",
			reason: "test",
			callBackAt: null,
			optOut: false,
			source: "conversation",
			durationSeconds: 12,
			at: OPT_OUT.at,
		});
	});
});
