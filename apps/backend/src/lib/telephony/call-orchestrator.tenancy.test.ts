/**
 * THE LIVE-CALL MAP IS PROCESS-WIDE. One orchestrator serves every customer on the
 * box, and its `calls` map is plain memory - so nothing in Postgres can save a
 * forgotten filter here. This is the read path where a missing tenant argument would
 * not merely show the wrong rows: it would let one customer HANG UP another
 * customer's caller, or transfer that caller to an operator in the wrong company.
 *
 * These tests seed two live calls belonging to two tenants and then ask the four
 * public methods for one tenant's view. The load-bearing assertion is the negative
 * one: the fake ARI records every hangup it is asked for, and it must record NONE
 * when the wrong tenant asks. Delete the tenant check in hangupCall() and this file
 * goes red on that line.
 *
 * No database and no Asterisk: the calls are constructed through the orchestrator's
 * own factory, which is what makes them the same shape a real call has.
 */

import { describe, expect, test } from "bun:test";
import { asTenantId, type TenantId } from "@shared/types";

import type { AudioSocketServer } from "@/lib/ai";
import type { AriEventStream } from "@/lib/asterisk";

import { CallOrchestrator, type LiveCallSnapshot } from "./call-orchestrator";
import type { AriClient, AsteriskChannel } from "./contracts";

/** Two customers. Valid v4 uuids, because TenantId is validated, not just branded. */
const TENANT_A = asTenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const TENANT_B = asTenantId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

const CALL_A = "11111111-1111-4111-8111-111111111111";
const CALL_B = "22222222-2222-4222-8222-222222222222";

interface Internals {
	calls: Map<string, { callId: string; tenantId: TenantId; channelId: string }>;
	createActiveCall(spec: {
		callId: string;
		tenantId: TenantId;
		channel: AsteriskChannel;
		callerNumber: string;
		dialledExtension: string | null;
		direction: "inbound" | "outbound";
		outbound: null;
		contact: null;
		startedAt: Date;
	}): { callId: string; tenantId: TenantId; channelId: string };
}

function fakeChannel(id: string): AsteriskChannel {
	return {
		id,
		name: `PJSIP/101-${id.slice(0, 8)}`,
		state: "Up",
		caller: { number: "998901234567", name: "" },
		connected: { number: "", name: "" },
		dialplan: { context: "from-external", exten: "101", priority: 1 },
		creationtime: "2026-08-14T09:00:00.000+0000",
		language: "uz",
	};
}

/** Records what was asked of Asterisk. The hangup list is the evidence. */
function fakeAri(): { ari: AriClient; hangups: string[] } {
	const hangups: string[] = [];

	const ari = {
		hangup: async (channelId: string) => {
			hangups.push(channelId);
		},
		originate: async () => {
			throw new Error("no Asterisk in this test");
		},
		destroyBridge: async () => undefined,
		setVariable: async () => undefined,
	} as unknown as AriClient;

	return { ari, hangups };
}

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

/** An orchestrator with one live call per tenant, and nothing else. */
function withTwoTenantsLive(): { orchestrator: CallOrchestrator; hangups: string[] } {
	const { ari, hangups } = fakeAri();
	const orchestrator = new CallOrchestrator({
		ari,
		events: fakeEvents(),
		audioSocket: fakeAudioSocket(),
	});
	const internals = orchestrator as unknown as Internals;

	for (const [callId, tenantId] of [
		[CALL_A, TENANT_A],
		[CALL_B, TENANT_B],
	] as const) {
		internals.calls.set(
			callId,
			internals.createActiveCall({
				callId,
				tenantId,
				channel: fakeChannel(callId),
				callerNumber: "998901234567",
				dialledExtension: "101",
				direction: "inbound",
				outbound: null,
				contact: null,
				startedAt: new Date(),
			})
		);
	}

	return { orchestrator, hangups };
}

describe("the live-call board is one customer's board", () => {
	test("listActiveCalls returns only the tenant's own calls", () => {
		const { orchestrator } = withTwoTenantsLive();

		const forA: LiveCallSnapshot[] = orchestrator.listActiveCalls(TENANT_A);

		expect(forA.map((snapshot) => snapshot.callId)).toEqual([CALL_A]);
		expect(forA[0]?.tenantId).toBe(TENANT_A);
		expect(orchestrator.listActiveCalls(TENANT_B).map((s) => s.callId)).toEqual([CALL_B]);
	});

	test("a tenant with no live calls sees an empty board, not the platform's", () => {
		const { orchestrator } = withTwoTenantsLive();

		expect(
			orchestrator.listActiveCalls(asTenantId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"))
		).toEqual([]);
	});

	test("the count is per customer, while the platform-wide one stays available", () => {
		const { orchestrator } = withTwoTenantsLive();

		expect(orchestrator.activeCallCountFor(TENANT_A)).toBe(1);
		expect(orchestrator.activeCallCountFor(TENANT_B)).toBe(1);
		// The unscoped count is a vendor/diagnostics number and is deliberately unchanged.
		expect(orchestrator.activeCallCount).toBe(2);
	});

	test("getActiveCall answers null for another customer's live call", () => {
		const { orchestrator } = withTwoTenantsLive();

		expect(orchestrator.getActiveCall(TENANT_A, CALL_A)?.callId).toBe(CALL_A);
		// Null, exactly as for a call that is not live at all: the HTTP layer turns both
		// into the same 404, so this does not confirm that the call exists.
		expect(orchestrator.getActiveCall(TENANT_B, CALL_A)).toBeNull();
		expect(orchestrator.getActiveCall(TENANT_A, "33333333-3333-4333-8333-333333333333")).toBeNull();
	});
});

describe("a live call can only be controlled by the customer it belongs to", () => {
	test("hangupCall refuses another tenant's call AND never touches the channel", async () => {
		const { orchestrator, hangups } = withTwoTenantsLive();

		const stopped = await orchestrator.hangupCall(TENANT_B, CALL_A, "wrong-tenant");

		expect(stopped).toBe(false);
		// THE assertion in this file: the caller was not hung up. Without the tenant check
		// in hangupCall() this list contains CALL_A's channel and a stranger's call has
		// been dropped mid-sentence.
		expect(hangups).toEqual([]);
		// And the call is still live for its own tenant.
		expect(orchestrator.getActiveCall(TENANT_A, CALL_A)).not.toBeNull();
	});

	test("transferCall refuses another tenant's call", async () => {
		const { orchestrator } = withTwoTenantsLive();

		// Null means "not a live call of yours", which the route answers 404 to. Reaching
		// the transfer machinery would have rung an operator in the wrong company and
		// handed them somebody else's caller.
		const outcome = await orchestrator.transferCall(TENANT_B, CALL_A, { reason: "wrong-tenant" });

		expect(outcome).toBeNull();
	});
});
