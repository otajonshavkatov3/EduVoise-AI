/**
 * THE RAW SQL THE QUERY SCANNER CANNOT READ.
 *
 * Knowledge retrieval is two hand-written statements: a document-frequency pass and
 * a scoring pass. Both interpolate a `WHERE` built by profileFilter(), and both are
 * `db.execute(sql\`...\`)` - which means lib/tenancy/query-guard.ts cannot say
 * anything about them (it counts table access it can see textually, and a string
 * template is a string), and the type checker cannot either (an SQL fragment is an
 * SQL fragment whatever is in it).
 *
 * So the tenant term in those two statements is guarded by nobody except this file.
 * It compiles the fragments through drizzle's own dialect and asserts that
 * `tenant_id` is in the SQL and the tenant id is in the parameters. It fails if the
 * tenant is dropped from profileFilter, and it fails if tenantWhere() stops emitting
 * the predicate at all - which is the one change that would silently unscope every
 * query in the codebase at once.
 *
 * These are the sentences the agent reads out to a stranger on a recorded line. A
 * missing filter here is not a data leak on a page; it is one business quoting
 * another's prices out loud.
 */

import { describe, expect, test } from "bun:test";
import { asTenantId } from "@shared/types";
import { PgDialect } from "drizzle-orm/pg-core";

import {
	buildDocumentFrequencyQuery,
	buildScoreQuery,
	type SearchTerm,
	stemToken,
	termPattern,
} from "./knowledge";

const dialect = new PgDialect();

/** Two ids that cannot be confused for each other in an assertion. */
const TENANT_ID = asTenantId("11111111-1111-4111-8111-111111111111");
const OTHER_TENANT_ID = asTenantId("22222222-2222-4222-8222-222222222222");
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";

function compile(fragment: ReturnType<typeof buildScoreQuery>): {
	text: string;
	params: unknown[];
} {
	const query = dialect.sqlToQuery(fragment);

	return { text: query.sql, params: query.params };
}

function term(token: string): SearchTerm {
	const stem = stemToken(token);

	return { token, stem, pattern: termPattern(stem), weight: 10, documentFrequency: 1 };
}

describe("the knowledge base scoring query names the tenant", () => {
	test("the score query filters on tenant_id and binds the tenant", () => {
		const { text, params } = compile(
			buildScoreQuery(TENANT_ID, PROFILE_ID, [term("narxlaringiz")], 5)
		);

		expect(text).toContain("tenant_id");
		expect(params).toContain(TENANT_ID);
		// The profile is not a substitute for the tenant: the profile id arrives from a
		// client (?profileId=, body.profileId), so it is exactly the value that must not
		// be the only thing standing between two businesses.
		expect(params).toContain(PROFILE_ID);
		expect(params).not.toContain(OTHER_TENANT_ID);
	});

	test("the document-frequency query filters on tenant_id and binds the tenant", () => {
		// This pass decides each token's WEIGHT, so an unscoped version would measure
		// how common a word is across every customer's content and change which answer
		// the agent picks - a leak that never shows a foreign row and still changes what
		// is said.
		const { text, params } = compile(
			buildDocumentFrequencyQuery(TENANT_ID, PROFILE_ID, [termPattern(stemToken("narx"))])
		);

		expect(text).toContain("tenant_id");
		expect(params).toContain(TENANT_ID);
	});

	test("the tenant term survives a query with many terms", () => {
		// The score expression is built by joining one fragment per term. A tenant term
		// that only appeared for the single-term case would pass the tests above and
		// leak on every real caller question, which is never one word.
		const { text, params } = compile(
			buildScoreQuery(TENANT_ID, PROFILE_ID, [term("kafolat"), term("muddati"), term("qancha")], 5)
		);

		expect(text).toContain("tenant_id");
		expect(params).toContain(TENANT_ID);
	});

	test("two tenants produce two different queries", () => {
		// Guards against the fragment being memoised or the id being ignored: if these
		// were equal, the parameter is decoration.
		const mine = compile(buildScoreQuery(TENANT_ID, PROFILE_ID, [term("narx")], 5));
		const theirs = compile(buildScoreQuery(OTHER_TENANT_ID, PROFILE_ID, [term("narx")], 5));

		expect(mine.params).not.toEqual(theirs.params);
		expect(theirs.params).toContain(OTHER_TENANT_ID);
	});
});
