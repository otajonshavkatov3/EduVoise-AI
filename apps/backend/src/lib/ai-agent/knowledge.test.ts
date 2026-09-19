import { describe, expect, test } from "bun:test";
import { asTenantId } from "@shared/types";
import { PgDialect } from "drizzle-orm/pg-core";

import {
	buildDocumentFrequencyQuery,
	buildScoreQuery,
	FIELD_WEIGHT,
	hitThreshold,
	normalizeForSearch,
	type SearchTerm,
	stemToken,
	termPattern,
	termWeight,
	tokenize,
} from "./knowledge";

/**
 * What these tests actually protect.
 *
 * Retrieval decides which business facts the agent is holding when it opens its
 * mouth, and every failure it can have is audible on a recorded line: the wrong
 * answer to a real question, or a confident answer to a question the business
 * never covered. All four of the things that used to go wrong are pinned here
 * with the caller wording that exposed them on the live tenant:
 *
 *   1. an Uzbek suffix on the caller's word ("narxlaringiz" vs the stored
 *      "narxi") used to find nothing at all
 *   2. an apostrophe written any of five ways ("to'lov" / "toʻlov" / "tolov")
 *      used to be three different words
 *   3. grammatical filler ("berasizmi") scored like a topic word, so any polite
 *      question retrieved four unrelated entries with full confidence
 *   4. "AI" — the flagship service of the seeded tenant — was two characters
 *      long and thrown away before the query ran
 *
 * Nothing here touches the database: the pattern a stem produces is valid POSIX
 * in both Postgres and JavaScript, so the same string is asserted against
 * sample text with RegExp, and the query itself is asserted by rendering it.
 */

const dialect = new PgDialect();
const PROFILE = "8f1c9d2e-0000-4000-8000-000000000001";
/** Any valid uuid: the point is only that the tenant reaches the generated SQL. */
const TENANT = asTenantId("3b7d5a10-0000-4000-8000-0000000000aa");

/** The pattern as Postgres will apply it, applied here instead. */
function matches(pattern: string, text: string): boolean {
	return new RegExp(pattern).test(normalizeForSearch(text));
}

function term(token: string, weight = 10): SearchTerm {
	const stem = stemToken(token);

	return { token, stem, pattern: termPattern(stem), weight, documentFrequency: 1 };
}

describe("normalizeForSearch", () => {
	test("folds every apostrophe a keyboard, a phone or an ASR produces", () => {
		const written = ["to'lov", "toʻlov", "toʼlov", "to‘lov", "to’lov", "tolov"];

		for (const variant of written) {
			expect(normalizeForSearch(variant)).toBe("tolov");
		}
	});

	test("lowercases Uzbek and Russian alike", () => {
		expect(normalizeForSearch("Ma'lumot")).toBe("malumot");
		expect(normalizeForSearch("Сколько СТОИТ")).toBe("сколько стоит");
	});
});

describe("tokenize", () => {
	test("keeps two-letter words: AI, UI and UX are services here", () => {
		expect(tokenize("AI kerak")).toEqual(["ai"]);
		expect(tokenize("ui ux dizayn")).toEqual(["ui", "ux", "dizayn"]);
	});

	test("drops words that are noise in every business", () => {
		expect(tokenize("Assalomu alaykum, iltimos narx kerak")).toEqual(["narx"]);
	});

	test("splits on the apostrophe's absence, not on the apostrophe", () => {
		expect(tokenize("bo'lib to'lash")).toEqual(["bolib", "tolash"]);
		expect(tokenize("boʻlib toʻlash")).toEqual(["bolib", "tolash"]);
	});

	test("deduplicates and caps a monologue", () => {
		expect(tokenize("narx narx narxi")).toEqual(["narx", "narxi"]);
		expect(tokenize(Array.from({ length: 30 }, (_, i) => `soz${i}`).join(" "))).toHaveLength(12);
	});
});

describe("stemToken", () => {
	// Every row here is a caller phrasing that returned nothing on the live
	// tenant, next to the stored word it has to reach.
	const table: [caller: string, stored: string][] = [
		["narxlaringiz", "narxi"],
		["narxingiz", "narx"],
		["narxlari", "narxlar"],
		["kafolatingiz", "kafolat"],
		["kafolatlaringiz", "kafolati"],
		["chatbotni", "chatbot"],
		["chatbotingiz", "chatbotlar"],
		["muddatingiz", "muddati"],
		["dizayningiz", "dizayn"],
		["tajribalaringiz", "tajriba"],
		["xavfsizligingiz", "xavfsizlik"],
		["texnologiyalaringizni", "texnologiyalar"],
		["офиса", "офис"],
		["сроки", "срок"],
	];

	for (const [caller, stored] of table) {
		test(`"${caller}" reaches "${stored}"`, () => {
			expect(matches(termPattern(stemToken(caller)), stored)).toBe(true);
		});
	}

	test("never strips a word down to a syllable", () => {
		expect(stemToken("ish")).toBe("ish");
		expect(stemToken("narx")).toBe("narx");
		expect(stemToken("sayt")).toBe("sayt");
	});
});

describe("termPattern", () => {
	test("matches a word prefix, so a stored suffix is found too", () => {
		expect(matches(termPattern("narx"), "Narxi qancha turadi?")).toBe(true);
		expect(matches(termPattern("kafolat"), "Kafolat berasizmi?")).toBe(true);
	});

	test("respects word boundaries: 'ish' no longer hides inside 'uchrashish'", () => {
		expect(matches(termPattern("ish"), "Uchrashish mumkinmi?")).toBe(false);
		expect(matches(termPattern("ish"), "Kishi keldi")).toBe(false);
		expect(matches(termPattern("ish"), "Ishlaymiz")).toBe(true);
	});

	test("matches two-letter tokens whole, never as a prefix", () => {
		expect(matches(termPattern("ai"), "AI agent kerak")).toBe(true);
		expect(matches(termPattern("ai"), '["ai", "model"]')).toBe(true);
		expect(matches(termPattern("ai"), "Aytib bering")).toBe(false);
	});

	test("finds a Cyrillic word, which Postgres' own \\m anchor cannot under C collation", () => {
		expect(matches(termPattern(stemToken("цена")), "Цена")).toBe(true);
	});
});

describe("termWeight", () => {
	test("a word in most of the knowledge base decides nothing", () => {
		// "berasizmi" was in 29 of the seeded tenant's 55 questions.
		expect(termWeight(29, 55)).toBe(0);
	});

	test("a common but meaningful word can break a tie, not make a hit", () => {
		expect(termWeight(12, 55)).toBe(3);
		expect(termWeight(12, 55) * FIELD_WEIGHT.question).toBeLessThan(30);
	});

	test("a rare word carries a hit on its own", () => {
		expect(termWeight(1, 55)).toBe(10);
		expect(termWeight(1, 55) * FIELD_WEIGHT.question).toBeGreaterThanOrEqual(30);
	});

	test("an absent word is worth nothing at all", () => {
		expect(termWeight(0, 55)).toBe(0);
	});

	test("a young knowledge base has no frequencies worth trusting", () => {
		// 3 of 5 entries is 60% and would be dismissed as noise on a full tenant.
		expect(termWeight(3, 5)).toBe(10);
	});
});

describe("hitThreshold", () => {
	test("one informative word in a question or a tag is the line", () => {
		expect(hitThreshold([term("kiberxavfsizlik")], 1)).toBe(30);
		expect(FIELD_WEIGHT.question * 10).toBeGreaterThanOrEqual(30);
		expect(FIELD_WEIGHT.answer * 10).toBeLessThan(30);
	});

	test("a one-word question made of a common word still gets an answer", () => {
		expect(hitThreshold([term("jamoa", 3)], 1)).toBe(12);
	});

	test("but not when the caller used a word this business has never heard", () => {
		// "kvartira sotasizmi": one of the two words is absent, so the relaxation
		// is off and the surviving word has to carry a full hit by itself.
		expect(hitThreshold([term("sotasizmi", 3)], 2)).toBe(30);
	});

	test("a long question needs a real match, not one incidental word", () => {
		const terms = [term("gaz"), term("tolov"), term("yerdan")];

		expect(hitThreshold(terms, 5)).toBe(30);
	});
});

describe("the generated SQL", () => {
	test("counts each pattern across the profile's active entries", () => {
		const { sql: text, params } = dialect.sqlToQuery(
			buildDocumentFrequencyQuery(TENANT, PROFILE, [termPattern("narx"), termPattern("kafolat")])
		);

		expect(text).toContain("count(*) FILTER (WHERE haystack ~ $");
		expect(text).toContain("df_0");
		expect(text).toContain("df_1");
		expect(text).toContain('"is_active" = $');
		expect(params).toContain(PROFILE);
		expect(params).toContain(termPattern("narx"));
		// THE isolation assertion. Document frequency is what decides whether a word is
		// informative, so an unscoped count would weight one business's vocabulary by
		// another's - and the leading tenant term is also what idx_kb_tenant_profile
		// needs. Removing the tenant filter fails here.
		expect(text).toContain('"tenant_id" = $');
		expect(params).toContain(TENANT);
	});

	test("weights a tag above a question and a question above an answer", () => {
		const kafolat = term("kafolat");
		const { sql: text, params } = dialect.sqlToQuery(
			buildScoreQuery(TENANT, PROFILE, [kafolat], 4)
		);

		expect(text).toMatch(/CASE WHEN question_text ~ \$\d+ THEN \$\d+/);
		expect(text).toMatch(/CASE WHEN tags_text ~ \$\d+ THEN \$\d+/);
		expect(text).toMatch(/CASE WHEN answer_text ~ \$\d+ THEN \$\d+/);

		// The three field weights and the term's own weight all reach the query,
		// and the pattern is bound rather than interpolated.
		expect(params).toContain(FIELD_WEIGHT.question);
		expect(params).toContain(FIELD_WEIGHT.tags);
		expect(params).toContain(FIELD_WEIGHT.answer);
		expect(params).toContain(kafolat.weight);
		expect(params).toContain(kafolat.pattern);
		expect(params).toContain(PROFILE);
		// The rows the agent is about to read out loud, filtered by whose they are.
		expect(text).toContain('"tenant_id" = $');
		expect(params).toContain(TENANT);
		expect(FIELD_WEIGHT.tags).toBeGreaterThan(FIELD_WEIGHT.question);
		expect(FIELD_WEIGHT.question).toBeGreaterThan(FIELD_WEIGHT.answer);
	});

	test("carries each term's own weight into the sum", () => {
		const { sql: text } = dialect.sqlToQuery(
			buildScoreQuery(TENANT, PROFILE, [term("narx"), term("jamoa", 3)], 4)
		);

		// Two weighted blocks, added together.
		expect(text.match(/CASE WHEN question_text/g)).toHaveLength(2);
		expect(text).toContain(") + ");
	});

	test("breaks ties deterministically, so a fact cannot drift out of the prompt", () => {
		const { sql: text } = dialect.sqlToQuery(buildScoreQuery(TENANT, PROFILE, [term("narx")], 4));

		expect(text).toContain('ORDER BY "matchScore" DESC, priority DESC, id ASC');
	});
});
