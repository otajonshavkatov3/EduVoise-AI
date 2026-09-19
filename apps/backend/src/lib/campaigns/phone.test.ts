/**
 * The stored form of a phone number.
 *
 * This is the file that decides whether a lead, a contact and a call are the same
 * person, so it is tested against the four spellings this database already holds -
 * "201", "anonymous", "905706507" and "998905706507" - plus the ways a human writes
 * a number into a spreadsheet.
 */
import { describe, expect, test } from "bun:test";

import { formatPhone, isExtension, normalisePhone } from "./phone";

/** The stored form, or the reject reason. Keeps the table below readable. */
function normalise(input: string): string {
	const result = normalisePhone(input);

	return result.ok ? result.phone : `!${result.reason}`;
}

describe("normalisePhone: what the database already holds", () => {
	test("a 12-digit number is already in the stored form", () => {
		expect(normalise("998905706507")).toBe("998905706507");
	});

	test("the same number written nationally gets the country code", () => {
		expect(normalise("905706507")).toBe("998905706507");
	});

	test("both spellings collapse to one, which is the whole point", () => {
		expect(normalise("905706507")).toBe(normalise("+998 90 570 65 07"));
	});

	test("an internal extension keeps its three digits", () => {
		const result = normalisePhone("201");

		expect(result.ok).toBe(true);
		expect(result.ok && result.phone).toBe("201");
		expect(result.ok && result.kind).toBe("extension");
	});

	test("«anonymous» is not a number", () => {
		expect(normalise("anonymous")).toBe("!not_a_number");
	});
});

describe("normalisePhone: how humans write numbers", () => {
	const cases: [string, string][] = [
		["+998905706507", "998905706507"],
		["+998 90 570 65 07", "998905706507"],
		["998-90-570-65-07", "998905706507"],
		["(90) 570-65-07", "998905706507"],
		["90.570.65.07", "998905706507"],
		["00998905706507", "998905706507"],
		["8 90 570 65 07", "998905706507"],
		["  998905706507  ", "998905706507"],
		// A foreign number is kept as its own E.164 digits, not forced to +998.
		["+7 495 123 45 67", "74951234567"],
		["+1 202 555 0143", "12025550143"],
	];

	for (const [input, expected] of cases) {
		test(`"${input}" -> ${expected}`, () => {
			expect(normalise(input)).toBe(expected);
		});
	}

	test("the AI agent's own extension normalises like any other", () => {
		expect(normalise("900")).toBe("900");
	});
});

describe("normalisePhone: what is refused, and why", () => {
	test("a number with a letter in it is refused before stripping", () => {
		// Stripping first would turn this into a valid number and dial a row nobody vetted.
		expect(normalise("anonymous 998901112233")).toBe("!not_a_number");
		expect(normalise("998o05706507")).toBe("!not_a_number");
	});

	test("an empty cell is reported as empty, not as malformed", () => {
		expect(normalise("")).toBe("!empty");
		expect(normalise("   ")).toBe("!empty");
	});

	test("too few digits to be either an extension or a number", () => {
		expect(normalise("12")).toBe("!too_short");
		expect(normalise("5705")).toBe("!too_short");
		expect(normalise("90570650")).toBe("!too_short");
	});

	test("more digits than E.164 allows", () => {
		expect(normalise("9989057065071234")).toBe("!too_long");
	});

	test("a leading zero is refused rather than guessed at", () => {
		// Guessing which trunk prefix this is would dial somebody else.
		expect(normalise("0905706507")).toBe("!leading_zero");
	});

	test("every rejection carries a sentence a person can act on", () => {
		const result = normalisePhone("12");

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.message.length).toBeGreaterThan(10);
		// Uzbek, and it says what a good number looks like.
		expect(result.ok === false && result.message).toContain("998905706507");
	});
});

describe("isExtension", () => {
	test("three digits is an extension, twelve is not", () => {
		expect(isExtension("201")).toBe(true);
		expect(isExtension("101")).toBe(true);
		expect(isExtension("998905706507")).toBe(false);
	});

	test("a three-character non-number is not an extension", () => {
		expect(isExtension("abc")).toBe(false);
	});
});

describe("formatPhone", () => {
	test("an Uzbek mobile is grouped for display", () => {
		expect(formatPhone("998905706507")).toBe("+998 90 570 65 07");
	});

	test("an extension is shown as dialled", () => {
		expect(formatPhone("201")).toBe("201");
	});

	test("a foreign number gets a plus and nothing else", () => {
		expect(formatPhone("74951234567")).toBe("+74951234567");
	});
});
