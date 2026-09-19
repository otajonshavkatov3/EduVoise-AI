import type { TenantId, UserRoleType } from "@shared/types";
import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";

import { forbidden, invalidToken, tokenExpired, unauthorized } from "@/lib/errors";
import { auditVendorAccess } from "@/lib/tenancy/audit-vendor";
import type { TenantScope } from "@/lib/tenancy/scope";
import { getTenantById, isTenantOperational } from "@/lib/tenancy/store";
import type { AppBindings } from "@/lib/types";

import { verifyAccessToken } from "./jwt";

const ROLE_LABELS: Record<UserRoleType, string> = {
	supervisor: "Nazoratchi",
	admin: "Administrator",
	manager: "Menejer",
	vendor: "Platforma egasi",
};

/** Roles reach the user in a 403 message, so name them the way the UI does. */
function describeRoles(roles: UserRoleType[]): string {
	return roles.map((role) => ROLE_LABELS[role] ?? role).join(", ");
}

/** The bearer token, or the 401 that says why there isn't one. */
function readBearerToken(header: string | undefined): string {
	if (!header) {
		throw unauthorized("Avtorizatsiya sarlavhasi yuborilmadi");
	}

	if (!header.startsWith("Bearer ")) {
		throw unauthorized("Avtorizatsiya sarlavhasi formati noto'g'ri");
	}

	const token = header.slice(7);

	if (!token) {
		throw unauthorized("Token yuborilmadi");
	}

	return token;
}

/** The token's claims, with jose's failures translated into this API's 401s. */
async function readPayload(token: string): Promise<Awaited<ReturnType<typeof verifyAccessToken>>> {
	try {
		return await verifyAccessToken(token);
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes("expired")) {
				throw tokenExpired();
			}
			if (error.message.includes("signature") || error.message.includes("malformed")) {
				throw invalidToken();
			}
		}

		throw invalidToken();
	}
}

/**
 * The tenant this request acts inside, refused when it cannot work.
 *
 * Deliberately NOT inside the token try/catch: a 403 for a suspended customer must
 * not be swallowed and reported as an invalid token, which is what one big catch
 * block around the whole middleware would have done.
 */
async function requireOperationalTenant(tenantId: TenantId) {
	const tenant = await getTenantById(tenantId);

	if (!tenant) {
		// The tenant was deleted (or the token was minted against another database).
		// Nothing in this request can be scoped, so it cannot be served.
		throw invalidToken("Token yaroqsiz: mijoz hisobi topilmadi");
	}

	if (!isTenantOperational(tenant.status)) {
		// Suspended is what phase two flips when the minutes run out; closed is an
		// offboarded customer. Both keep their data and lose their access.
		throw forbidden(
			tenant.status === "suspended"
				? "Hisob to'xtatilgan. Iltimos, xizmat ko'rsatuvchi bilan bog'laning."
				: "Hisob yopilgan"
		);
	}

	return tenant;
}

export const authMiddleware = createMiddleware<AppBindings>(async (c, next) => {
	const payload = await readPayload(readBearerToken(c.req.header("Authorization")));

	/**
	 * A vendor token whose tenant is not the vendor's own is the platform owner
	 * working inside a customer's account. The `act` claim is minted only by the
	 * enter endpoint, so this cannot be produced by a customer's own token.
	 */
	const isVendorAccess = payload.act !== undefined && payload.act.tid !== payload.tid;

	await requireOperationalTenant(payload.tid);

	const scope: TenantScope = {
		tenantId: payload.tid,
		actor: {
			userId: payload.sub,
			// The REAL role, which is what the audit trail and requireVendor() read.
			role: payload.role,
			// When impersonating, the actor's home tenant is the vendor's; otherwise
			// the user's own account tenant is the one the token acts inside.
			homeTenantId: payload.act?.tid ?? payload.tid,
		},
		isVendorAccess,
	};

	c.set("user", {
		id: payload.sub,
		// The EFFECTIVE role, and the two differ in exactly one case.
		//
		// A vendor inside a customer's account acts with that customer's most senior
		// role. Not cosmetic: authorisation in this codebase is not only requireRole()
		// gates - handlers also test membership of inline lists (CAN_SEE_ALL_CALLS,
		// CAN_SEE_COST, "a manager sees only their own tickets"). A literal "vendor"
		// role passes none of those, so the platform owner would enter a customer's
		// account and be shown an empty dashboard - which is not "can do everything",
		// it is a support tool that cannot support anybody.
		//
		// Mapping it here, once, is what keeps "vendor" out of forty role arrays that
		// later phases would each have to remember. What it does NOT do is hide the
		// vendor: scope.actor.role above is the truth, isVendorAccess is set, and every
		// request is audited as vendor access before the handler runs.
		role: isVendorAccess ? "supervisor" : payload.role,
		tenantId: payload.tid,
	});
	c.set("tenant", scope);

	// The trace the vendor cannot avoid leaving. Written BEFORE the handler runs, so
	// a read that then fails is still recorded as an attempt - "I only looked at a
	// page that errored" is not a defence anybody should have to accept.
	if (isVendorAccess) {
		await auditVendorAccess(c, scope);
	}

	await next();
});

/**
 * Does this role satisfy a tenant-local role gate?
 *
 * A vendor inside a customer's account already arrives here as "supervisor" (see
 * the effective-role mapping above), so this extra clause only covers the vendor
 * acting in their OWN tenant - the vendor console's own routes. The vendor-ONLY
 * gate is the opposite direction and lives in lib/tenancy/scope.ts::requireVendor().
 */
function satisfiesRole(role: UserRoleType, allowedRoles: UserRoleType[]): boolean {
	return role === "vendor" || allowedRoles.includes(role);
}

export function requireRole(...allowedRoles: UserRoleType[]) {
	return createMiddleware<AppBindings>(async (c: Context<AppBindings>, next: Next) => {
		const user = c.get("user");

		if (!user) {
			throw unauthorized();
		}

		if (!satisfiesRole(user.role, allowedRoles)) {
			throw forbidden(`Ruxsat yo'q. Kerakli rollar: ${describeRoles(allowedRoles)}`);
		}

		await next();
	});
}

/** Throw forbidden if current user's role is not in allowedRoles. Use in handlers instead of inline role checks. */
export function requireRoles(c: Context<AppBindings>, allowedRoles: UserRoleType[]) {
	const user = c.get("user");
	if (!user) {
		throw unauthorized();
	}
	if (!satisfiesRole(user.role, allowedRoles)) {
		throw forbidden(`Ruxsat yo'q. Kerakli rollar: ${describeRoles(allowedRoles)}`);
	}
}
