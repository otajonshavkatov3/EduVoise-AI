/**
 * The enforcement seam's own behaviour.
 *
 * These are small assertions about small functions, and they are here because
 * every one of them is a property the 148 rewritten query sites will depend on
 * without re-checking:
 *
 *   - the tenant is the LEADING term of the WHERE, so the (tenant_id, ...) indexes
 *     are the ones that get used;
 *   - an undefined optional filter does not silently drop the tenant with it;
 *   - a row from another tenant is reported as 404, never 403.
 */

import { describe, expect, test } from "bun:test";
import { asTenantId } from "@shared/types";
import { eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { calls, contacts } from "@/db/schema";
import { AppError } from "@/lib/errors";

import { isVendorRole, requireTenantRow, tenantWhere } from "./scope";

const TENANT_A = asTenantId("00000000-0000-0000-0000-00000000000a");
const TENANT_B = asTenantId("00000000-0000-0000-0000-00000000000b");

/**
 * The real SQL and its parameters, so these assertions are about the query
 * Postgres will actually run rather than about drizzle internals.
 */
const dialect = new PgDialect();

function render(where: SQL): { sql: string; params: unknown[] } {
	const query = dialect.sqlToQuery(where);

	return { sql: query.sql, params: query.params };
}

describe("tenantWhere", () => {
	test("puts the tenant first, before any other condition", () => {
		const rendered = render(tenantWhere(calls, TENANT_A, eq(calls.status, "answered"))).sql;

		const tenantAt = rendered.indexOf("tenant_id");
		const statusAt = rendered.indexOf(`"status"`);

		expect(tenantAt).toBeGreaterThanOrEqual(0);
		expect(statusAt).toBeGreaterThanOrEqual(0);
		// Leading column order is not cosmetic: an index whose first column is not
		// tenant_id is a full scan per request.
		expect(tenantAt).toBeLessThan(statusAt);
	});

	test("still filters by tenant when every optional condition is undefined", () => {
		const rendered = render(tenantWhere(contacts, TENANT_A, undefined, undefined));

		expect(rendered.sql).toContain("tenant_id");
		expect(rendered.params).toEqual([TENANT_A]);
	});

	test("carries the tenant value that was passed, not some other id", () => {
		const rendered = render(tenantWhere(calls, TENANT_B));

		expect(rendered.params).toEqual([TENANT_B]);
		expect(rendered.params).not.toContain(TENANT_A);
	});
});

describe("requireTenantRow", () => {
	test("returns the row when it belongs to this tenant", () => {
		const row = { tenantId: TENANT_A, id: "x" };

		expect(requireTenantRow(row, TENANT_A)).toBe(row);
	});

	test("reports another tenant's row as 404, never 403", () => {
		const row = { tenantId: TENANT_B, id: "x" };

		try {
			requireTenantRow(row, TENANT_A, "Qo'ng'iroq");
			throw new Error("expected requireTenantRow to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(AppError);
			// 403 would confirm the id exists somewhere else, which is itself a
			// disclosure: it turns an id-guessing attempt into an oracle.
			expect((error as AppError).statusCode).toBe(404);
		}
	});

	test("treats a missing row the same way", () => {
		expect(() => requireTenantRow(null, TENANT_A)).toThrow();
		expect(() => requireTenantRow(undefined, TENANT_A)).toThrow();
	});
});

describe("asTenantId", () => {
	test("accepts a uuid and rejects anything else", () => {
		expect(asTenantId("00000000-0000-0000-0000-00000000000a")).toBe(TENANT_A);

		// The boundary that stops a slug, an extension or an empty string from being
		// carried into a query as though it were a tenant.
		expect(() => asTenantId("avilab")).toThrow();
		expect(() => asTenantId("")).toThrow();
		expect(() => asTenantId("00000000-0000-0000-0000-00000000000")).toThrow();
	});

	test("does not leak the rejected value into the error message", () => {
		// The value can come from an untrusted request and the message reaches the logs.
		try {
			asTenantId("' OR 1=1 --");
			throw new Error("expected asTenantId to throw");
		} catch (error) {
			expect((error as Error).message).not.toContain("OR 1=1");
		}
	});
});

describe("isVendorRole", () => {
	test("only the vendor role is the vendor", () => {
		expect(isVendorRole("vendor")).toBe(true);
		expect(isVendorRole("supervisor")).toBe(false);
		expect(isVendorRole("admin")).toBe(false);
		expect(isVendorRole("manager")).toBe(false);
	});
});
