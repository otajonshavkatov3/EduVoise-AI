/**
 * placeOutboundCall - the gate every campaign dial has to pass through.
 *
 * These tests deliberately never let a dial reach the database. Everything
 * asserted here happens BEFORE the `calls` row is written, which is exactly where
 * it has to happen: a number that is on the do-not-call list must not leave a
 * trace of having been considered, and must certainly not be rung.
 *
 * The orchestrator is driven with fakes for its three collaborators (ARI, the ARI
 * event stream, the AudioSocket listener) so a refusal can be observed without a
 * carrier, a database or a running Asterisk. The single most important assertion
 * in the file is the negative one: `originate` was never called.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { asTenantId } from "@shared/types";
import type { AudioSocketServer } from "@/lib/ai";
import type { AriEventStream } from "@/lib/asterisk";
import { CallOrchestrator } from "./call-orchestrator";
import type { AriClient, AriOriginateOptions, AsteriskChannel } from "./contracts";
import { setOutboundDialerHooks } from "./outbound";

// ===========================================
// Fakes
// ===========================================

/** Records what was asked of Asterisk; answers nothing it is not asked for. */
function fakeAri(): { ari: AriClient; originations: AriOriginateOptions[] } {
	const originations: AriOriginateOptions[] = [];

	const ari = {
		originate: async (options: AriOriginateOptions): Promise<AsteriskChannel> => {
			originations.push(options);
			throw new Error("no Asterisk in this test");
		},
		hangup: async () => undefined,
	} as unknown as AriClient;

	return { ari, originations };
}

/** The event stream, reduced to the three methods start()/stop() actually use. */
function fakeEvents(): AriEventStream {
	return {
		on: () => () => undefined,
		start: () => undefined,
		stop: () => undefined,
	} as unknown as AriEventStream;
}

function fakeAudioSocket(): AudioSocketServer {
	return {
		start: async () => ({ host: "127.0.0.1", port: 0 }),
		stop: async () => undefined,
		on: () => () => undefined,
	} as unknown as AudioSocketServer;
}

async function startedOrchestrator(ari: AriClient): Promise<CallOrchestrator> {
	const orchestrator = new CallOrchestrator({
		ari,
		events: fakeEvents(),
		audioSocket: fakeAudioSocket(),
	});

	await orchestrator.start();

	return orchestrator;
}

const PURPOSE = {
	kind: "reminder" as const,
	campaignName: "Avgust eslatmalari",
	purpose: "profilaktik ko'rikka yozilishni eslatish",
	openingLine: null,
	script: null,
	leadName: null,
	variables: {},
	notes: null,
};

let running: CallOrchestrator | null = null;

afterEach(async () => {
	setOutboundDialerHooks(null);

	if (running !== null) {
		await running.stop();
		running = null;
	}
});

// ===========================================
// The guardrail
// ===========================================

/**
 * Whose calls these are. Nothing here touches the database, so the id only has to
 * be a valid branded one - the point is that it is threaded, because the dial
 * pattern (hence the trunk) and the do-not-call list are per tenant.
 */
const TENANT = asTenantId("00000000-0000-0000-0000-0000000000aa");

describe("placeOutboundCall refuses before it dials", () => {
	test("never rings a number on the do-not-call list", async () => {
		const { ari, originations } = fakeAri();

		setOutboundDialerHooks({
			isDoNotCall: (_tenantId, phone) => phone === "998901234567",
		});

		running = await startedOrchestrator(ari);

		const result = await running.placeOutboundCall({
			tenantId: TENANT,
			number: "+998 90 123 45 67",
			purpose: PURPOSE,
		});

		// THE assertion. Everything else in this feature is a convenience; this is
		// the promise it makes.
		expect(originations).toHaveLength(0);

		expect(result.placed).toBe(false);

		if (result.placed) {
			throw new Error("unreachable");
		}

		expect(result.refusal).toBe("do_not_call");
		expect(result.outcome).toBe("opt_out");
		// No call row was written, so there is nothing to point at.
		expect(result.callId).toBeNull();
		// Uzbek, and safe to render straight onto the campaign page.
		expect(result.message).toContain("ro'yxatida");
	});

	test("checks the list on the DIGITS, however the list wrote the number", async () => {
		const { ari, originations } = fakeAri();
		const asked: string[] = [];

		setOutboundDialerHooks({
			isDoNotCall: (_tenantId, phone) => {
				asked.push(phone);
				return true;
			},
		});

		running = await startedOrchestrator(ari);
		await running.placeOutboundCall({
			tenantId: TENANT,
			number: "+998-90-123-45-67",
			purpose: PURPOSE,
		});

		// A person who opted out as "998901234567" must still be protected when a
		// later import spells the same number with punctuation.
		expect(asked).toEqual(["998901234567"]);
		expect(originations).toHaveLength(0);
	});

	test("refuses to dial when the do-not-call check itself is broken", async () => {
		const { ari, originations } = fakeAri();

		setOutboundDialerHooks({
			isDoNotCall: () => {
				throw new Error("the campaign tables are mid-migration");
			},
		});

		running = await startedOrchestrator(ari);

		const result = await running.placeOutboundCall({
			tenantId: TENANT,
			number: "101",
			purpose: PURPOSE,
		});

		expect(originations).toHaveLength(0);
		expect(result.placed).toBe(false);
	});

	test("refuses a number that is not dialable, without writing a call row", async () => {
		const { ari, originations } = fakeAri();

		running = await startedOrchestrator(ari);

		const result = await running.placeOutboundCall({
			tenantId: TENANT,
			number: "12",
			purpose: PURPOSE,
		});

		expect(originations).toHaveLength(0);
		expect(result.placed).toBe(false);

		if (result.placed) {
			throw new Error("unreachable");
		}

		// An unusable number IS a fact about the lead, so it comes back as an outcome
		// the dialer should store and never retry.
		expect(result.refusal).toBe("invalid_number");
		expect(result.outcome).toBe("invalid_number");
		expect(result.callId).toBeNull();
	});

	test("refuses to dial at all when the telephony layer is not running", async () => {
		const { ari, originations } = fakeAri();
		// Deliberately NOT started: nothing is subscribed to StasisStart, so whoever
		// answered would reach silence.
		const orchestrator = new CallOrchestrator({
			ari,
			events: fakeEvents(),
			audioSocket: fakeAudioSocket(),
		});

		const result = await orchestrator.placeOutboundCall({
			tenantId: TENANT,
			number: "101",
			purpose: PURPOSE,
		});

		expect(originations).toHaveLength(0);
		expect(result.placed).toBe(false);

		if (result.placed) {
			throw new Error("unreachable");
		}

		expect(result.refusal).toBe("not_running");
		// Not the lead's fault, so nothing is filed against them and no attempt of
		// theirs is burned.
		expect(result.outcome).toBeNull();
	});
});
