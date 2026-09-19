/**
 * The paste parser.
 *
 * What is actually being tested is whether an owner's real spreadsheet survives the
 * trip: the delimiter it happens to use, whether it has a header row, and whether the
 * per-lead values that make each call different from the last one arrive intact.
 */
import { describe, expect, test } from "bun:test";

import { parseLeadText } from "./parse-leads";

const MAX = 1000;

describe("delimiter detection", () => {
	test("a tab-separated paste out of Excel", () => {
		const parsed = parseLeadText("998901234567\tAlisher\n998901234568\tDilnoza", MAX);

		expect(parsed.delimiter).toBe("\t");
		expect(parsed.rows).toHaveLength(2);
		expect(parsed.rows[0]?.fullName).toBe("Alisher");
	});

	test("semicolons win over commas, because a name may contain a comma", () => {
		const parsed = parseLeadText("998901234567;Karimov, Alisher;qarz=450000", MAX);

		expect(parsed.delimiter).toBe(";");
		expect(parsed.rows[0]?.fullName).toBe("Karimov, Alisher");
		expect(parsed.rows[0]?.variables).toEqual({ qarz: "450000" });
	});

	test("plain CSV", () => {
		const parsed = parseLeadText("998901234567,Alisher", MAX);

		expect(parsed.delimiter).toBe(",");
		expect(parsed.rows[0]?.phone).toBe("998901234567");
	});
});

describe("header detection", () => {
	test("a header row names the columns, and those names become variables", () => {
		const parsed = parseLeadText(
			["telefon;ism;qarz;sana", "998901234567;Alisher;450000;15-avgust"].join("\n"),
			MAX
		);

		expect(parsed.headers).toEqual(["telefon", "ism", "qarz", "sana"]);
		expect(parsed.rows).toHaveLength(1);
		expect(parsed.rows[0]?.fullName).toBe("Alisher");
		expect(parsed.rows[0]?.variables).toEqual({ qarz: "450000", sana: "15-avgust" });
	});

	test("English and mixed header names are recognised as the name column", () => {
		const parsed = parseLeadText(
			["phone,name,product", "998901234567,Alisher,Website"].join("\n"),
			MAX
		);

		expect(parsed.rows[0]?.fullName).toBe("Alisher");
		expect(parsed.rows[0]?.variables).toEqual({ product: "Website" });
	});

	test("a first line that starts with a number is a lead, not a header", () => {
		const parsed = parseLeadText("998901234567;Alisher", MAX);

		expect(parsed.headers).toBeNull();
		expect(parsed.rows).toHaveLength(1);
	});

	test("a three-digit extension in the first line is data, not a header", () => {
		// The threshold is three digits precisely because 201 is the shortest dialable thing.
		const parsed = parseLeadText("201;Amrbek", MAX);

		expect(parsed.headers).toBeNull();
		expect(parsed.rows[0]?.phone).toBe("201");
	});
});

describe("per-lead variables - the difference between a follow-up and a robocall", () => {
	test("key=value cells name themselves with no header", () => {
		const parsed = parseLeadText("998901234567;Alisher;qarz=450000;sana=15-avgust", MAX);

		expect(parsed.rows[0]?.variables).toEqual({ qarz: "450000", sana: "15-avgust" });
	});

	test("unnamed extra cells become var1, var2 in order", () => {
		const parsed = parseLeadText("998901234567;Alisher;450000;15-avgust", MAX);

		expect(parsed.rows[0]?.variables).toEqual({ var1: "450000", var2: "15-avgust" });
	});

	test("empty cells produce no variable rather than an empty one", () => {
		const parsed = parseLeadText("998901234567;Alisher;;15-avgust", MAX);

		expect(parsed.rows[0]?.variables).toEqual({ var1: "15-avgust" });
	});

	test("a phone-only paste is valid and carries no variables", () => {
		const parsed = parseLeadText("998901234567\n998901234568", MAX);

		expect(parsed.rows).toHaveLength(2);
		expect(parsed.rows[0]?.fullName).toBeNull();
		expect(parsed.rows[0]?.variables).toEqual({});
	});

	test("a long merge value is truncated rather than dropped", () => {
		const parsed = parseLeadText(`998901234567;Alisher;izoh=${"x".repeat(400)}`, MAX);

		expect(parsed.rows[0]?.variables.izoh?.length).toBe(200);
	});
});

describe("lines the parser sets aside", () => {
	test("blank lines and comments are ignored, and do not shift the line numbers", () => {
		const parsed = parseLeadText(
			["# mijozlar ro'yxati", "", "998901234567;Alisher", "", "998901234568;Dilnoza"].join("\n"),
			MAX
		);

		expect(parsed.rows).toHaveLength(2);
		// The line number is the real line in the paste, so the UI can point at it.
		expect(parsed.rows[0]?.line).toBe(3);
		expect(parsed.rows[1]?.line).toBe(5);
	});

	test("a line whose first cell is empty is reported as ignored", () => {
		const parsed = parseLeadText(["998901234567;Alisher", ";Dilnoza"].join("\n"), MAX);

		expect(parsed.rows).toHaveLength(1);
		expect(parsed.ignoredLines).toEqual([2]);
	});

	test("windows line endings", () => {
		const parsed = parseLeadText("998901234567;Alisher\r\n998901234568;Dilnoza", MAX);

		expect(parsed.rows).toHaveLength(2);
		expect(parsed.rows[1]?.fullName).toBe("Dilnoza");
	});

	test("a paste longer than the cap imports its first rows and says so", () => {
		const text = Array.from({ length: 10 }, (_, index) => `99890123456${index}`).join("\n");
		const parsed = parseLeadText(text, 4);

		expect(parsed.rows).toHaveLength(4);
		expect(parsed.truncated).toBe(true);
	});

	test("nothing usable at all is an empty result, not a throw", () => {
		const parsed = parseLeadText("\n\n   \n# faqat izoh\n", MAX);

		expect(parsed.rows).toHaveLength(0);
		expect(parsed.truncated).toBe(false);
	});
});

describe("the parser does not validate numbers", () => {
	test("a malformed number is parsed as a row and rejected later, with its line number", () => {
		// Splitting the two jobs is what lets the import report WHICH line is wrong.
		const parsed = parseLeadText(["998901234567;Alisher", "anonymous;Kim"].join("\n"), MAX);

		expect(parsed.rows).toHaveLength(2);
		expect(parsed.rows[1]?.phone).toBe("anonymous");
		expect(parsed.rows[1]?.line).toBe(2);
	});
});
