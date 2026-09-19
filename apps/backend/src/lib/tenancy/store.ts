/**
 * The tenant registry: reading a tenant row, cheaply and often.
 *
 * The auth middleware needs a tenant's status on EVERY authenticated request (a
 * suspended customer must stop working the moment the vendor suspends them), and
 * a tenant row changes a few times a year. So the table is held in an in-process
 * Map and dropped on write, exactly like lib/settings does it - see
 * invalidateTenantCache(), which the vendor console must call after any update.
 *
 * Single Bun process, so invalidate-on-write is enough. A second process would
 * need a channel; the cache is keyed by id and rebuilt with one indexed query, so
 * that day is a small change here and nowhere else.
 */
import { asTenantId, type TenantId } from "@shared/types";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { type TenantRecord, type TenantStatus, tenants } from "@/db/schema";

const byId = new Map<TenantId, TenantRecord>();
const bySlug = new Map<string, TenantRecord>();

/** null = looked up and genuinely absent, so a bad id is not re-queried per request. */
const missingIds = new Set<TenantId>();

let vendorTenantId: TenantId | null = null;

/**
 * The single customer tenant, while there is only one. See getSoleTenantId().
 * `resolved` distinguishes "not looked up yet" from "looked up, not unique".
 */
let soleTenant: { resolved: boolean; id: TenantId | null } = { resolved: false, id: null };

function remember(row: TenantRecord): TenantRecord {
	byId.set(row.id, row);
	bySlug.set(row.slug, row);
	missingIds.delete(row.id);

	if (row.isVendor) {
		vendorTenantId = row.id;
	}

	return row;
}

/**
 * Drop cached rows. With no argument it clears everything, including the vendor
 * row and the sole-tenant answer - which is what creating a tenant must do.
 */
export function invalidateTenantCache(tenantId?: TenantId): void {
	if (tenantId) {
		const cached = byId.get(tenantId);

		if (cached) {
			bySlug.delete(cached.slug);
		}

		byId.delete(tenantId);
		missingIds.delete(tenantId);

		return;
	}

	byId.clear();
	bySlug.clear();
	missingIds.clear();
	vendorTenantId = null;
	soleTenant = { resolved: false, id: null };
}

export async function getTenantById(tenantId: TenantId): Promise<TenantRecord | null> {
	const cached = byId.get(tenantId);

	if (cached) {
		return cached;
	}

	if (missingIds.has(tenantId)) {
		return null;
	}

	const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

	if (!row) {
		missingIds.add(tenantId);
		return null;
	}

	return remember(row);
}

export async function getTenantBySlug(slug: string): Promise<TenantRecord | null> {
	const cached = bySlug.get(slug);

	if (cached) {
		return cached;
	}

	const [row] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);

	return row ? remember(row) : null;
}

/**
 * A customer may work: trial and active yes, suspended and closed no.
 *
 * Phase two flips `suspended` when the minutes run out; nothing else about the
 * enforcement has to change, because the auth middleware already asks this
 * question on every request.
 */
export function isTenantOperational(status: TenantStatus): boolean {
	return status === "trial" || status === "active";
}

/**
 * The vendor's own tenant row - the one every vendor user belongs to.
 *
 * Throws when it is missing: that is a broken installation (the migration seeds
 * it), and inventing a fallback would mean deciding at runtime that some customer
 * tenant is the vendor.
 */
export async function getVendorTenantId(): Promise<TenantId> {
	if (vendorTenantId) {
		return vendorTenantId;
	}

	const [row] = await db.select().from(tenants).where(eq(tenants.isVendor, true)).limit(1);

	if (!row) {
		throw new Error("No vendor tenant row: the tenancy migration has not been applied");
	}

	return remember(row).id;
}

/** Every tenant, vendor row included. For the vendor console only. */
export async function listAllTenants(): Promise<TenantRecord[]> {
	const rows = await db.select().from(tenants).orderBy(tenants.createdAt);

	for (const row of rows) {
		remember(row);
	}

	return rows;
}

/**
 * TRANSITIONAL SEAM - phase one of four.
 *
 * The voice layer does not yet learn which tenant a call belongs to: that arrives
 * with the per-tenant dialplan and PJSIP contexts in a later phase. Until it does,
 * a handful of call sites need a tenant and have none to hand, and there are
 * exactly two honest answers: "the only customer there is", or an error.
 *
 * This function gives the first while it is true and the second the instant it
 * stops being - it THROWS as soon as a second customer tenant exists, rather than
 * picking one. A thrown error on tenant number two is a loud, immediate failure in
 * the phase that creates tenant number two, which is precisely the phase that must
 * thread the real tenant through. Returning "the first row" instead would answer
 * calls for customer B with customer A's agent, prices and knowledge base, and
 * nobody would find out from a log line.
 *
 * Every caller is marked with a TODO(tenancy) comment so the remaining ones are
 * one grep away.
 */
export async function getSoleTenantId(): Promise<TenantId> {
	if (soleTenant.resolved && soleTenant.id) {
		return soleTenant.id;
	}

	const rows = await db
		.select({ id: tenants.id, isVendor: tenants.isVendor })
		.from(tenants)
		.limit(3);

	const customers = rows.filter((row) => !row.isVendor);

	if (customers.length === 0) {
		soleTenant = { resolved: true, id: null };
		throw new Error("No customer tenant exists yet");
	}

	if (customers.length > 1) {
		soleTenant = { resolved: true, id: null };
		throw new Error(
			"More than one tenant exists: this call site must be given the request's or the call's tenant"
		);
	}

	const only = asTenantId(customers[0]?.id ?? "");
	soleTenant = { resolved: true, id: only };

	return only;
}

/**
 * The same answer without awaiting, for the timers and event handlers in the voice
 * layer that cannot.
 *
 * Returns null rather than throwing when it is not primed or no longer unique.
 * Null means "no tenant known", and every caller treats that as "use the platform
 * defaults from the environment" - which is a wrong-but-vendor-chosen
 * configuration, never another customer's. Primed by getSoleTenantId(), which the
 * orchestrator reaches at the top of every call.
 */
export function soleTenantIdOrNull(): TenantId | null {
	return soleTenant.id;
}
