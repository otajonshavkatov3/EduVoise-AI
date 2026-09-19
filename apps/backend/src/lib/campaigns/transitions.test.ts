/**
 * The transition table.
 *
 * Every cell of it, in both directions: the legal moves lead where they claim to,
 * and every illegal move throws with a 422 and an Uzbek sentence. The one that
 * matters most is "cancelled cannot be started", because getting that wrong re-dials
 * everybody who already said no.
 */
import { describe, expect, test } from "bun:test";

import type { CampaignStatus } from "@/db/schema";
import { AppError } from "@/lib/errors";

import {
	assertTransition,
	availableActions,
	type CampaignAction,
	canTransition,
	describeRefusal,
	isEditable,
	targetStatus,
} from "./transitions";

const ALL_STATUSES: CampaignStatus[] = ["draft", "running", "paused", "finished", "cancelled"];
const ALL_ACTIONS: CampaignAction[] = ["start", "pause", "cancel", "finish"];

/** Exactly the moves that are allowed. Anything not listed here must be refused. */
const LEGAL: [CampaignStatus, CampaignAction, CampaignStatus][] = [
	["draft", "start", "running"],
	["paused", "start", "running"],
	["running", "pause", "paused"],
	["draft", "cancel", "cancelled"],
	["running", "cancel", "cancelled"],
	["paused", "cancel", "cancelled"],
	["running", "finish", "finished"],
	["paused", "finish", "finished"],
];

describe("legal transitions", () => {
	for (const [from, action, to] of LEGAL) {
		test(`${from} --${action}--> ${to}`, () => {
			expect(canTransition(from, action)).toBe(true);
			expect(assertTransition(from, action)).toBe(to);
			expect(targetStatus(action)).toBe(to);
		});
	}
});

describe("everything else is refused", () => {
	const legalKeys = new Set(LEGAL.map(([from, action]) => `${from}:${action}`));

	for (const from of ALL_STATUSES) {
		for (const action of ALL_ACTIONS) {
			if (legalKeys.has(`${from}:${action}`)) {
				continue;
			}

			test(`${from} --${action}--> refused`, () => {
				expect(canTransition(from, action)).toBe(false);
				expect(() => assertTransition(from, action)).toThrow(AppError);
			});
		}
	}

	test("the refusal is a 422 with an Uzbek message, not a 400", () => {
		// The request was well formed; the state of the world is what makes it impossible.
		try {
			assertTransition("cancelled", "start");
			throw new Error("expected assertTransition to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);

			const appError = err as AppError;

			expect(appError.statusCode).toBe(422);
			expect(appError.code).toBe("INVALID_OPERATION");
			expect(appError.message).toContain("Bekor qilingan kampaniya");
		}
	});
});

describe("the sentences a person reads", () => {
	test("a terminal campaign is told to make a new one, not to retry", () => {
		expect(describeRefusal("finished", "start")).toContain("yangi kampaniya");
		expect(describeRefusal("cancelled", "start")).toContain("yangi kampaniya");
	});

	test("an already-running campaign says so plainly", () => {
		expect(describeRefusal("running", "start")).toBe("Kampaniya allaqachon ishlayapti.");
	});

	test("a draft told to pause is told to start first", () => {
		expect(describeRefusal("draft", "pause")).toContain("ishga tushirilishi kerak");
	});

	test("every illegal move has a hand-written sentence, not the generic fallback", () => {
		// The fallback exists so a future status cannot produce an empty message, but no
		// illegal move should be reaching it today.
		const generic = describeRefusal("draft", "start");

		for (const from of ALL_STATUSES) {
			for (const action of ALL_ACTIONS) {
				if (canTransition(from, action)) {
					continue;
				}

				expect(describeRefusal(from, action)).not.toBe(generic);
			}
		}
	});

	test("the fallback itself is readable Uzbek naming the state and the action", () => {
		const message = describeRefusal("draft", "start");

		expect(message).toContain("qoralama");
		expect(message).toContain("ishga tushirish");
	});
});

describe("availableActions", () => {
	test("a draft may be started or cancelled, not paused", () => {
		expect(availableActions("draft")).toEqual(["start", "cancel"]);
	});

	test("a running campaign may be paused or cancelled", () => {
		expect(availableActions("running")).toEqual(["pause", "cancel"]);
	});

	test("a paused campaign may be resumed or cancelled", () => {
		expect(availableActions("paused")).toEqual(["start", "cancel"]);
	});

	test("a terminal campaign offers nothing", () => {
		expect(availableActions("finished")).toEqual([]);
		expect(availableActions("cancelled")).toEqual([]);
	});

	test("«finish» is never offered as a button", () => {
		for (const status of ALL_STATUSES) {
			expect(availableActions(status)).not.toContain("finish");
		}
	});
});

describe("isEditable", () => {
	test("a running campaign is editable - stopping earlier must not need a cancel", () => {
		expect(isEditable("running")).toBe(true);
		expect(isEditable("draft")).toBe(true);
		expect(isEditable("paused")).toBe(true);
	});

	test("history is not editable", () => {
		expect(isEditable("finished")).toBe(false);
		expect(isEditable("cancelled")).toBe(false);
	});
});
