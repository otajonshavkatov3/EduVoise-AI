/**
 * record_call_outcome: who is offered it, and what it accepts.
 *
 * Two things are protected here.
 *
 * The tool is offered on campaign calls and on NOTHING else. An inbound call has
 * no campaign row for an outcome to be written to, and a tool the model can call
 * but nothing can act on is worse than a missing one - it produces a session
 * where the agent believes it has recorded a refusal that went nowhere.
 *
 * And an outcome the model spelled its own way is resolved rather than rejected,
 * with ONE exception: a word nobody recognises is refused instead of defaulted.
 * Defaulting an unknown outcome to "answered" would file a refusal as a
 * conversation and an opt-out as a shrug, and the person would be rung again.
 */
import { describe, expect, test } from "bun:test";
import type { OutboundCallPurpose } from "@/lib/telephony/contracts";
import {
	buildToolDefinitions,
	OUTBOUND_CALL_OUTCOMES,
	resolveOutboundOutcome,
	toolsForCall,
	validateToolArguments,
} from "./tools";

const CATEGORIES = ["Qabulga yozilish", "Narx savoli", "Boshqa"];

const CAMPAIGN: OutboundCallPurpose = {
	kind: "sales",
	campaignName: "Yozgi chegirma",
	purpose: "yangi tarifni taklif qilish",
	openingLine: null,
	script: null,
	leadName: null,
	variables: {},
	notes: null,
};

function names(tools: readonly { name: string }[]): string[] {
	return tools.map((tool) => tool.name);
}

// ===========================================
// Who gets the tool
// ===========================================

describe("record_call_outcome is advertised by direction", () => {
	test("an inbound call is offered exactly the shared eight", () => {
		const shared = buildToolDefinitions(CATEGORIES);

		expect(names(shared)).not.toContain("record_call_outcome");
		expect(shared).toHaveLength(8);
	});

	test("an outbound call gets the ninth tool appended", () => {
		const tools = buildToolDefinitions(CATEGORIES, { outbound: true });

		expect(names(tools)).toContain("record_call_outcome");
		expect(tools).toHaveLength(9);
	});

	test("the shared eight keep their order and their shape when it is appended", () => {
		// The model's own prompt cache keys on the tool list, so the outbound tool is
		// appended rather than woven in.
		const shared = buildToolDefinitions(CATEGORIES);
		const outbound = buildToolDefinitions(CATEGORIES, { outbound: true });

		expect(outbound.slice(0, 8)).toEqual(shared);
	});
});

describe("toolsForCall derives the list from the session context", () => {
	const shared = buildToolDefinitions(CATEGORIES);

	test("adds nothing when the context carries no campaign", () => {
		// Both spellings of "inbound": the field absent, and the field explicitly null.
		expect(toolsForCall(shared, {})).toEqual(shared);
		expect(toolsForCall(shared, { campaign: null })).toEqual(shared);
	});

	test("adds the outcome tool when the platform placed the call", () => {
		expect(names(toolsForCall(shared, { campaign: CAMPAIGN }))).toContain("record_call_outcome");
	});

	test("is idempotent, so a reconnect cannot advertise it twice", () => {
		// OpenAI Realtime re-sends session.update after a reconnect from the same
		// stored list; a duplicated tool name is rejected for the whole session.
		const once = toolsForCall(shared, { campaign: CAMPAIGN });
		const twice = toolsForCall(once, { campaign: CAMPAIGN });

		expect(twice).toEqual(once);
		expect(names(twice).filter((name) => name === "record_call_outcome")).toHaveLength(1);
	});
});

// ===========================================
// What it accepts
// ===========================================

describe("record_call_outcome validation", () => {
	test("accepts each of the seven outcomes a person's words can produce", () => {
		for (const outcome of OUTBOUND_CALL_OUTCOMES) {
			const result = validateToolArguments("record_call_outcome", {
				outcome,
				reason: "test",
			});

			expect(result.ok).toBe(true);
		}
	});

	test("resolves every wording of 'stop calling me' to opt_out", () => {
		// This table exists for exactly one reason: a model that answers "do_not_call"
		// instead of "opt_out" must not have the request thrown away as a validation
		// error.
		for (const spelling of ["do_not_call", "DNC", "unsubscribe", "blacklist", "opt-out"]) {
			expect(resolveOutboundOutcome(spelling)).toBe("opt_out");
		}
	});

	test("keeps 'not interested' as a refusal and not as an opt-out", () => {
		// Two different instructions. A business that collapses them is why people
		// stop answering the phone.
		expect(resolveOutboundOutcome("not_interested")).toBe("refused");
		expect(resolveOutboundOutcome("no")).toBe("refused");
	});

	test("REFUSES a word it does not recognise instead of guessing", () => {
		const result = validateToolArguments("record_call_outcome", {
			outcome: "maybe_sometime",
			reason: "test",
		});

		expect(result.ok).toBe(false);

		if (!result.ok) {
			// The error names the whole enum, so it is a turn the model can correct.
			expect(result.error).toContain("opt_out");
		}
	});

	test("fills in a placeholder reason rather than failing the call over one", () => {
		const result = validateToolArguments("record_call_outcome", { outcome: "agreed" });

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.args).toMatchObject({ outcome: "agreed", reason: "Sabab ko'rsatilmadi" });
		}
	});

	test("rejects a call-back time that is not a timestamp", () => {
		// "tomorrow at 3" is not something a scheduler can act on.
		const result = validateToolArguments("record_call_outcome", {
			outcome: "call_back",
			reason: "band",
			callBackAt: "ertaga soat 3 da",
		});

		expect(result.ok).toBe(false);
	});

	test("accepts a proper ISO-8601 call-back time", () => {
		// Relative to now, not a fixed date. The validator refuses a timestamp earlier
		// than yesterday, so a hardcoded one turns this test into a time bomb: it passed
		// when it was written and failed silently a week later, which is how the suite
		// arrived here with one red test that had nothing to do with the change being
		// verified.
		const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

		const result = validateToolArguments("record_call_outcome", {
			outcome: "call_back",
			reason: "band",
			callBackAt: tomorrow.toISOString(),
		});

		expect(result.ok).toBe(true);
	});
});
