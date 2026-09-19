/**
 * THE RATCHET. The number of unscoped reads may go down. It may not go up.
 *
 * Phase one gave every table a tenant_id and made every WRITE impossible to get
 * wrong (NOT NULL, so tsc refuses an insert with no tenant). Reads are the other
 * half, there are hundreds of them, and they are rewritten by the phases that come
 * after this one. Between now and then this test is the only thing standing between
 * "the reads are not scoped yet, and we know exactly which" and "the reads are not
 * scoped, and nobody is counting".
 *
 * It fails in two directions:
 *   - a file with MORE unscoped statements than its baseline: somebody added a read
 *     with no tenant in it;
 *   - a file not in the baseline at all with an unscoped statement: a new query site.
 *
 * A file that improves and drops below its baseline does not fail. The baseline is
 * simply stale at that point, and query-guard.baseline.ts says so; regenerating it
 * is a one-line change the improving phase should make.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { countByFile, readSourceFiles, scanSources } from "./query-guard";
import { UNSCOPED_BASELINE, UNSCOPED_BASELINE_TOTAL } from "./query-guard.baseline";

const SRC_DIR = join(import.meta.dir, "..", "..");

describe("tenant scope ratchet", () => {
	test("no file has more unscoped database statements than its baseline", async () => {
		const files = await readSourceFiles(SRC_DIR);
		const sites = scanSources(files);
		const counts = countByFile(sites);

		const regressions: string[] = [];

		for (const [file, count] of Object.entries(counts)) {
			const allowed = UNSCOPED_BASELINE[file] ?? 0;

			if (count > allowed) {
				const offending = sites
					.filter((site) => site.file === file)
					.slice(0, 8)
					.map((site) => `      line ${site.line}: ${site.table} (${site.kind}) ${site.text}`)
					.join("\n");

				regressions.push(
					`${file}: ${count} unscoped statements, baseline ${allowed}\n${offending}\n` +
						"      Fix: pass the request's tenant and filter with tenantWhere(table, tenantId, ...).\n" +
						"      See lib/tenancy/scope.ts."
				);
			}
		}

		// The message is the deliverable here: whoever broke it should not have to run
		// the scanner by hand to find out what they added.
		expect(regressions.join("\n\n")).toBe("");
	});

	test("the scanner still finds the query sites it is supposed to be watching", async () => {
		// A guard that silently stops matching passes forever. If a refactor changes how
		// queries are written (a wrapper, a different builder), this fails and the
		// scanner has to learn the new shape rather than quietly approving everything.
		const files = await readSourceFiles(SRC_DIR);
		const sites = scanSources(files);

		expect(files.length).toBeGreaterThan(50);
		expect(sites.length).toBeGreaterThan(0);
		expect(sites.length).toBeLessThanOrEqual(UNSCOPED_BASELINE_TOTAL);
	});

	test("no write site is unscoped, and that is enforced by the compiler", async () => {
		// tenant_id is NOT NULL on all 25 tables, so an insert without a tenant does not
		// type-check. This asserts the OBSERVABLE consequence: the scanner finds no
		// unscoped insert. If one appears that is not one of the two known
		// build-the-values-above sites below, a table has lost its NOT NULL - a schema
		// regression rather than a query-site one.
		//
		// The two exceptions are the limit of a textual scan, not real findings: both
		// pass a `values` object assembled a few lines earlier, and the tenant is in
		// THAT object (crm-writer's ai_sessions upsert takes it from the call;
		// campaign_leads' bulk import takes it from the request). The compiler is what
		// actually guarantees them, which is why they are named here rather than fixed.
		const knownValuesObjectSites = [
			"lib/telephony/crm-writer.ts",
			"routes/campaigns/campaigns.leads.handlers.ts",
		];

		const files = await readSourceFiles(SRC_DIR);
		const unscopedWrites = scanSources(files)
			.filter((site) => site.kind === "insert")
			.filter((site) => !knownValuesObjectSites.includes(site.file));

		expect(unscopedWrites.map((site) => `${site.file}:${site.line}`)).toEqual([]);
	});
});
