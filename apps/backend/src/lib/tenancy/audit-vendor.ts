/**
 * The vendor's paper trail.
 *
 * The vendor can enter any customer's account and read their calls, their
 * recordings and their transcripts. That power is necessary - somebody has to be
 * able to reproduce a customer's problem - and it is exactly the power that must
 * never be silent. Two rows make it visible:
 *
 *   vendor.tenant.enter   minted an impersonation token for this customer.
 *   vendor.access         one row per request made while inside the account,
 *                         with the method and path.
 *
 * Both are written with tenant_id = the CUSTOMER, so the customer's own audit page
 * shows them (it filters on tenant_id, like every other scoped query), and
 * actor_tenant_id = the vendor, so the vendor console can list its own staff's
 * activity. is_vendor_access = true on both, which is the flag the partial index
 * on audit_logs is built for.
 *
 * WHY PER REQUEST AND NOT PER SESSION. "The vendor was in this account between
 * 14:02 and 14:40" does not answer "did they open my customer's recording". A row
 * per request does, and it costs one INSERT on a path only the vendor's own staff
 * ever take. The write is awaited, deliberately: an audit row that is dropped
 * because the process was busy is an audit trail nobody can rely on.
 */
import type { Context } from "hono";

import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import type { AppBindings } from "@/lib/types";

import type { TenantScope } from "./scope";

function clientIp(c: Context<AppBindings>): string | null {
	const forwarded = c.req.header("x-forwarded-for");

	if (forwarded) {
		return forwarded.split(",")[0]?.trim().slice(0, 45) ?? null;
	}

	return c.req.header("x-real-ip")?.slice(0, 45) ?? null;
}

/** One row for one request made by the vendor inside a customer's account. */
export async function auditVendorAccess(
	c: Context<AppBindings>,
	scope: TenantScope
): Promise<void> {
	await db.insert(auditLogs).values({
		tenantId: scope.tenantId,
		actorTenantId: scope.actor.homeTenantId,
		isVendorAccess: true,
		userId: scope.actor.userId,
		action: "vendor.access",
		entityType: "request",
		details: {
			method: c.req.method,
			path: c.req.path,
		},
		ipAddress: clientIp(c),
		userAgent: c.req.header("user-agent") ?? null,
	});
}

/** One row when an impersonation token is minted. */
export async function auditVendorEnter(
	c: Context<AppBindings>,
	input: {
		vendorUserId: string;
		vendorTenantId: TenantScope["actor"]["homeTenantId"];
		targetTenantId: TenantScope["tenantId"];
		targetSlug: string;
		expiresIn: string;
		reason: string | null;
	}
): Promise<void> {
	await db.insert(auditLogs).values({
		tenantId: input.targetTenantId,
		actorTenantId: input.vendorTenantId,
		isVendorAccess: true,
		userId: input.vendorUserId,
		action: "vendor.tenant.enter",
		entityType: "tenant",
		entityId: input.targetTenantId,
		details: {
			slug: input.targetSlug,
			expiresIn: input.expiresIn,
			reason: input.reason,
		},
		ipAddress: clientIp(c),
		userAgent: c.req.header("user-agent") ?? null,
	});
}
