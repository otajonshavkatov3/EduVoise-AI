import type { TenantId } from "@shared/types";
import type { Context } from "hono";

import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import type { AppBindings } from "@/lib/types";

export type AuditPayload = {
	action: string;
	userId?: string | null;
	entityType?: string | null;
	entityId?: string | null;
	details?: Record<string, unknown> | null;
	/**
	 * The tenant the action affected.
	 *
	 * Optional on an authenticated request, where the request's own tenant is right
	 * for every ordinary action. REQUIRED on the unauthenticated ones - login,
	 * register, refresh - which run before a tenant scope exists but do know the
	 * tenant of the user they just authenticated, and also by the vendor console
	 * when it writes a row about a customer other than the one it is scoped to.
	 */
	tenantId?: TenantId | null;
};

function getClientIp(c: Context<AppBindings>): string | null {
	const forwarded = c.req.header("x-forwarded-for");
	if (forwarded) {
		return forwarded.split(",")[0]?.trim() ?? null;
	}
	return c.req.header("x-real-ip") ?? null;
}

function getUserAgent(c: Context<AppBindings>): string | null {
	return c.req.header("user-agent") ?? null;
}

/**
 * TZ: auditLogs — har bir muhim o'zgarishni qayd etish (userId, action, ipAddress).
 * Auth qilingan route'larda c.get("user").id ishlatiladi; userId ni alohida berish ham mumkin.
 *
 * Since tenancy the row also records WHOSE data was touched and WHO touched it -
 * the two stop being the same question once the vendor can enter an account. Both
 * come from the request's tenant scope, so no caller has to remember them.
 */
export async function audit(c: Context<AppBindings>, payload: AuditPayload): Promise<void> {
	const scope = c.get("tenant");
	const tenantId = payload.tenantId ?? scope?.tenantId ?? null;

	if (!tenantId) {
		// An audit row with no tenant cannot be written (the column is NOT NULL) and
		// must not be invented - attributing an action to an arbitrary tenant is worse
		// than not recording it. Reaching this is a programming error: an
		// unauthenticated caller has to pass the tenant it just authenticated.
		throw new Error("audit() needs a tenant: pass payload.tenantId on unauthenticated routes");
	}

	const userId = payload.userId ?? scope?.actor.userId ?? null;
	const ipAddress = getClientIp(c);
	const userAgent = getUserAgent(c);

	await db.insert(auditLogs).values({
		tenantId,
		// With no scope (login, register, refresh) the actor is the user themselves,
		// so the two tenants are the same and it is not vendor access.
		actorTenantId: scope?.actor.homeTenantId ?? tenantId,
		isVendorAccess: scope?.isVendorAccess ?? false,
		userId,
		action: payload.action,
		entityType: payload.entityType ?? null,
		entityId: payload.entityId ?? null,
		details: payload.details ?? null,
		ipAddress: ipAddress?.slice(0, 45) ?? null,
		userAgent,
	});
}
