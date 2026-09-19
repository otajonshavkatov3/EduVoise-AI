/**
 * The vendor console's backend, and the mechanism behind "the vendor can enter any
 * customer's account".
 *
 * HOW ENTERING WORKS, and why it is a token rather than a flag:
 *
 *   1. The vendor logs in normally and gets a token for the VENDOR tenant. Nothing
 *      about it grants access to a customer - it is scoped to a tenant with no
 *      calls in it.
 *   2. POST /vendor/tenants/:id/enter mints a SECOND, short-lived token whose
 *      tenant is the customer's, and whose `act` claim names the vendor and the
 *      vendor's own tenant.
 *   3. Every subsequent request with that token is scoped to the customer exactly
 *      like the customer's own request would be - the 148 query sites need no
 *      special case, which is the point: a vendor path that read data through a
 *      different code path is a vendor path that would drift out of scope.
 *
 * HOW IT IS DISTINGUISHED from the customer's own request: the `act` claim. Only
 * this endpoint mints it, so a customer's token cannot carry it, and the auth
 * middleware turns it into `scope.isVendorAccess`.
 *
 * HOW IT IS AUDITED: one row when the token is minted (vendor.tenant.enter) and one
 * row per request made with it (vendor.access), both written with tenant_id = the
 * CUSTOMER, so they appear in the customer's own audit log. See
 * lib/tenancy/audit-vendor.ts.
 *
 * The token is deliberately short-lived. A standing all-access credential in
 * somebody's browser storage is the kind of thing that ends up in a screenshot.
 */
import { asTenantId } from "@shared/types";

import { generateAccessToken } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import {
	auditVendorEnter,
	getTenantById,
	listAllTenants,
	requireVendor,
	toPublicTenant,
} from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";

import type { enterTenant, listTenants } from "./vendor.routes";

/**
 * How long an impersonation token lives.
 *
 * Long enough to reproduce a customer's problem, short enough that a token left in
 * a tab is not a standing key to somebody's business. The vendor re-enters when it
 * expires, and each entry writes its own audit row - which makes the trail read as
 * a series of visits rather than one endless session.
 */
const IMPERSONATION_TTL = "30m";

export const listTenantsHandler: AppRouteHandler<typeof listTenants> = async (c) => {
	await requireVendor(c);

	const rows = await listAllTenants();

	return c.json(
		{
			success: true as const,
			data: { items: rows.map((row) => toPublicTenant(row)) },
		},
		200
	);
};

export const enterTenantHandler: AppRouteHandler<typeof enterTenant> = async (c) => {
	const actor = await requireVendor(c);
	const targetId = asTenantId(c.req.valid("param").tenantId);
	const body = c.req.valid("json") ?? {};

	const target = await getTenantById(targetId);

	// 404 rather than 400 for a tenant that does not exist, and the same 404 a
	// customer would get: an endpoint that distinguishes "no such tenant" from "not
	// yours" is an endpoint that enumerates tenants.
	if (!target) {
		throw notFound("Mijoz", targetId);
	}

	if (target.isVendor) {
		// Entering your own tenant is not impersonation, and minting a token that
		// claims it is would put false rows in the audit trail.
		throw notFound("Mijoz", targetId);
	}

	const accessToken = await generateAccessToken({
		userId: actor.userId,
		// The vendor keeps their own role - the middleware is what lets a vendor
		// through a tenant-local role gate, so nothing here has to pretend to be a
		// supervisor.
		role: actor.role,
		tenantId: target.id,
		actor: { userId: actor.userId, tenantId: actor.homeTenantId },
		expiresIn: IMPERSONATION_TTL,
	});

	await auditVendorEnter(c, {
		vendorUserId: actor.userId,
		vendorTenantId: actor.homeTenantId,
		targetTenantId: target.id,
		targetSlug: target.slug,
		expiresIn: IMPERSONATION_TTL,
		reason: body.reason ?? null,
	});

	return c.json(
		{
			success: true as const,
			data: {
				accessToken,
				expiresIn: IMPERSONATION_TTL,
				tenant: toPublicTenant(target),
			},
		},
		200
	);
};
