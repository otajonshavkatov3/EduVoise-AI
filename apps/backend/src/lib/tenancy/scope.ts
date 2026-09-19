/**
 * THE ENFORCEMENT SEAM. Every tenant-scoped query goes through here.
 *
 * The rule for the 148 query sites is one line long:
 *
 *     const { tenantId } = tenantScope(c);
 *     await db.select().from(calls).where(tenantWhere(calls, tenantId, eq(calls.id, id)));
 *
 * WHAT IS MADE HARD, and how:
 *
 *   Passing the wrong id            `tenantWhere(calls, userId)` does not compile.
 *                                   TenantId is branded, and only asTenantId() or a
 *                                   tenant_id column produces one.
 *   Scoping a table that has no     `tenantWhere(tenants, id)` does not compile:
 *   tenant column                    the parameter is constrained to a table with a
 *                                    tenantId column.
 *   Inserting without a tenant      already impossible. Every tenant_id column is
 *                                    NOT NULL, so drizzle's insert type demands it
 *                                    and tsc refuses the call - that is how all 34
 *                                    write sites in this codebase were found.
 *   Leading-column mistakes         tenantWhere() always puts the tenant first in
 *                                    the AND, matching the (tenant_id, ...) indexes.
 *   Probing another tenant by id    requireTenantRow() answers 404, never 403: a
 *                                    403 would confirm the row exists somewhere
 *                                    else, which is itself a disclosure.
 *
 * WHAT IT CANNOT CATCH is written down in the report, not hidden here: a site that
 * filters on a tenant taken from the request body instead of the token, a join
 * whose second table is unscoped, and raw db.execute() SQL. The first two are what
 * query-guard.test.ts exists for.
 */
import type { TenantId, UserRoleType } from "@shared/types";
import { and, eq, type SQL } from "drizzle-orm";
import type { Context } from "hono";

import { forbidden, notFound, unauthorized } from "@/lib/errors";
import type { AppBindings } from "@/lib/types";

import { getVendorTenantId } from "./store";
import type { TenantScopedTable } from "./tables";

/** Who is acting, and which tenant that person's own account lives in. */
export interface TenantActor {
	userId: string;
	role: UserRoleType;
	/**
	 * The tenant the user record belongs to. For a vendor this is the vendor's own
	 * tenant, which is what makes "the vendor is acting inside somebody else's
	 * account" a comparison rather than a guess.
	 */
	homeTenantId: TenantId;
}

/** The tenant every query in the current request must be filtered by. */
export interface TenantScope {
	tenantId: TenantId;
	actor: TenantActor;
	/** True when a vendor is acting inside a customer's account. Audited. */
	isVendorAccess: boolean;
}

/**
 * The request's tenant scope, or 401.
 *
 * Throws rather than returning undefined: a handler that reached a query without a
 * resolved tenant is a handler mounted without the auth middleware, and answering
 * it with unscoped data is the failure this whole phase exists to prevent.
 */
export function tenantScope(c: Context<AppBindings>): TenantScope {
	const scope = c.get("tenant");

	if (!scope) {
		throw unauthorized("Tizimga kirish talab qilinadi");
	}

	return scope;
}

/** Shorthand for the common case: just the id. */
export function currentTenantId(c: Context<AppBindings>): TenantId {
	return tenantScope(c).tenantId;
}

/**
 * `tenant_id = $1 AND (...)`, tenant always first.
 *
 * Undefined conditions are dropped, so a caller can pass optional filters inline
 * without building an array.
 */
export function tenantWhere<T extends TenantScopedTable>(
	table: T,
	tenantId: TenantId,
	...conditions: (SQL | undefined)[]
): SQL {
	// The tenant term is the FIRST element and it is not optional. Building this list
	// empty and letting the callers' filters fill it - which is how this function was
	// found a moment ago - drops the tenant predicate out of every query in the
	// codebase at once, and `and()` of an empty list is `undefined`, so a call with no
	// extra filters becomes a bare `.where(undefined)`: a full-table read of every
	// customer's rows, from a call site that still reads as scoped.
	const parts: SQL[] = [eq(table.tenantId, tenantId)];

	for (const condition of conditions) {
		if (condition !== undefined) {
			parts.push(condition);
		}
	}

	// and() of a non-empty list is always an SQL, but its type allows undefined.
	return and(...parts) as SQL;
}

/**
 * A row fetched without a tenant filter, checked before it is used.
 *
 * For the few places where the tenant cannot be part of the WHERE - a row reached
 * through a relational query, a join whose result carries the tenant only on one
 * side. Answers 404 for a row belonging to another tenant, deliberately: "you may
 * not see this" tells the caller the id exists, and an id that exists somewhere
 * else is information they should not have.
 */
export function requireTenantRow<R extends { tenantId: TenantId }>(
	row: R | null | undefined,
	tenantId: TenantId,
	resource = "Ma'lumot"
): R {
	if (!row || row.tenantId !== tenantId) {
		throw notFound(resource);
	}

	return row;
}

/** True for the platform owner's own role. */
export function isVendorRole(role: UserRoleType): boolean {
	return role === "vendor";
}

/**
 * Only the vendor may pass. Used by the vendor console routes.
 *
 * Separate from requireRole("vendor") in lib/auth so the check reads as what it
 * is - a platform-level gate, not one of the tenant's own role rules.
 *
 * BOTH HALVES ARE REQUIRED, and the role alone is the dangerous half. A customer's
 * own administrator can create users inside their tenant; if the role string were
 * the whole gate, one row with role='vendor' in ANY customer's tenant would list
 * every tenant on the platform and mint an enter-token for each. So the actor's
 * home tenant must BE the vendor tenant - which is the comparison TenantActor's
 * own comment promises and this function was not making.
 */
export async function requireVendor(c: Context<AppBindings>): Promise<TenantActor> {
	const scope = tenantScope(c);

	if (!isVendorRole(scope.actor.role)) {
		throw forbidden("Bu amal faqat platforma egasi uchun");
	}

	if (scope.actor.homeTenantId !== (await getVendorTenantId())) {
		throw forbidden("Bu amal faqat platforma egasi uchun");
	}

	return scope.actor;
}
