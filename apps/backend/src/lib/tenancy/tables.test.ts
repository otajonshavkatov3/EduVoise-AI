/**
 * THE COVERAGE GUARD. This is the test that stops the next phase from leaking.
 *
 * The claim tenant isolation rests on is not "we added tenant_id to 25 tables" - it
 * is "EVERY table that holds customer data has a NOT NULL tenant_id". A claim like
 * that decays: phase two adds a minute ledger, phase three adds a per-tenant
 * dialplan table, and the person adding it is thinking about their feature. So the
 * claim is checked here against the real schema rather than trusted.
 *
 * A new table therefore has exactly two ways to pass: carry a tenant_id, or be
 * added to GLOBAL_TABLE_NAMES with a written justification next to it. There is no
 * third way, and "I forgot" is not one of them.
 */
import { describe, expect, test } from "bun:test";

import { allSchemaTables, GLOBAL_TABLE_NAMES, isTenantScopedTable, tableName } from "./tables";

/** Names as they appear in SQL, so a failure message is greppable. */
function names(tables: { table: Parameters<typeof tableName>[0] }[]): string[] {
	return tables.map((entry) => tableName(entry.table)).sort();
}

describe("schema tenant coverage", () => {
	test("every table is either tenant-scoped or explicitly global", () => {
		const tables = allSchemaTables();

		// Sanity: the walk itself must find the schema. A broken walk would make every
		// assertion below pass by finding nothing at all, which is the one failure mode
		// this test cannot afford.
		expect(tables.length).toBeGreaterThanOrEqual(26);

		const unscoped = tables.filter(
			(entry) =>
				!(isTenantScopedTable(entry.table) || GLOBAL_TABLE_NAMES.includes(tableName(entry.table)))
		);

		expect(names(unscoped)).toEqual([]);
	});

	test("the global list is exactly the tenant registry", () => {
		// Deliberately an equality assertion, not a subset one. Growing this list is
		// the single easiest way to introduce a cross-tenant read, so it has to be a
		// deliberate edit to this test as well as to the list.
		expect([...GLOBAL_TABLE_NAMES]).toEqual(["tenants"]);
	});

	test("every tenant_id is NOT NULL", () => {
		const nullable: string[] = [];

		for (const entry of allSchemaTables()) {
			if (!isTenantScopedTable(entry.table)) {
				continue;
			}

			if (!entry.table.tenantId.notNull) {
				nullable.push(tableName(entry.table));
			}
		}

		// A nullable tenant_id is a row that belongs to nobody - invisible to every
		// scoped query until somebody "fixes" it with `OR tenant_id IS NULL`, at which
		// point it is visible to everybody.
		expect(nullable).toEqual([]);
	});

	test("every tenant_id references the tenants table", () => {
		const missingFk: string[] = [];

		for (const entry of allSchemaTables()) {
			if (!isTenantScopedTable(entry.table)) {
				continue;
			}

			// drizzle keeps a table's inline foreign keys under this symbol; a tenant_id
			// with no FK is data that can outlive its owner.
			const foreignKeys = (entry.table as unknown as Record<symbol, unknown>)[
				Symbol.for("drizzle:PgInlineForeignKeys")
			];

			const list = Array.isArray(foreignKeys) ? foreignKeys : [];
			const referencesTenants = list.some((fk) => {
				const reference = (fk as { reference?: () => { foreignTable?: unknown } }).reference;

				if (typeof reference !== "function") {
					return false;
				}

				const foreignTable = reference().foreignTable;

				return (
					foreignTable !== undefined &&
					foreignTable !== null &&
					tableName(foreignTable as Parameters<typeof tableName>[0]) === "tenants"
				);
			});

			if (!referencesTenants) {
				missingFk.push(tableName(entry.table));
			}
		}

		expect(missingFk).toEqual([]);
	});
});
