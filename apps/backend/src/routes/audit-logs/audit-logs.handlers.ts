/**
 * The tenant's own audit trail.
 *
 * Scoped on `tenant_id`, which since tenancy means "whose data was touched" - not
 * `actor_tenant_id`, which is who touched it. The difference is the point: when the
 * vendor enters a customer's account, the rows the middleware writes carry the
 * CUSTOMER as tenant_id, so they appear here, in the customer's own log. Filtering
 * on the actor instead would hide exactly the access a customer most needs to see.
 */
import type { UserRoleType } from "@shared/types";
import { count, eq, gte, ilike, lte } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { requireRoles } from "@/lib/auth";
import { currentTenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";

import type { list } from "./audit-logs.routes";
import type { ListQuery } from "./audit-logs.schemas";

const AUDIT_VIEW_ROLES: UserRoleType[] = ["supervisor", "admin"];

function toItem(row: {
	id: string;
	userId: string | null;
	action: string;
	entityType: string | null;
	entityId: string | null;
	details: unknown;
	ipAddress: string | null;
	userAgent: string | null;
	createdAt: Date;
	user?:
		| { username: string | null; phone: string }
		| { username: string | null; phone: string }[]
		| null;
}) {
	const user = row.user && (Array.isArray(row.user) ? row.user[0] : row.user);
	const userName = user ? (user.username ?? user.phone) : null;
	return {
		id: row.id,
		userId: row.userId,
		userName,
		action: row.action,
		entityType: row.entityType,
		entityId: row.entityId,
		details: row.details as Record<string, unknown> | null,
		ipAddress: row.ipAddress,
		userAgent: row.userAgent,
		createdAt: row.createdAt.toISOString(),
	};
}

export const listHandler: AppRouteHandler<typeof list> = async (c) => {
	requireRoles(c, AUDIT_VIEW_ROLES);
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query") as ListQuery;
	const { page, limit, userId, action, from, to } = query;
	const offset = (page - 1) * limit;

	// Every filter below is a client-supplied value and every one of them is applied
	// INSIDE the tenant term: a `userId` from another customer, an `action` substring
	// or a date range cannot reach a row this tenant does not own.
	const conditions = [];
	if (userId) {
		conditions.push(eq(auditLogs.userId, userId));
	}
	if (action) {
		// Substring match, not a category prefix: the UI sends a whole action key
		// but a prefix such as "auth" must keep working for anyone calling the API
		// directly. An exact key also matches this pattern, so nothing regresses.
		const pattern = action.replace(/[%_\\]/g, (match) => `\\${match}`);
		conditions.push(ilike(auditLogs.action, `%${pattern}%`));
	}
	if (from) {
		conditions.push(gte(auditLogs.createdAt, new Date(from)));
	}
	if (to) {
		conditions.push(lte(auditLogs.createdAt, new Date(to)));
	}
	// Named after the helper on purpose: the ratchet in lib/tenancy/query-guard.ts is a
	// TEXTUAL scan, and a clause hidden behind a variable called `where` reads to it as
	// no tenant at all. Keeping the word in the name keeps the guard honest here.
	const tenantWhereClause = tenantWhere(auditLogs, tenantId, ...conditions);

	const [items, countResult] = await Promise.all([
		db.query.auditLogs.findMany({
			where: tenantWhereClause,
			columns: {
				id: true,
				userId: true,
				action: true,
				entityType: true,
				entityId: true,
				details: true,
				ipAddress: true,
				userAgent: true,
				createdAt: true,
			},
			// Unscoped side of the join, and the one place where that is not merely
			// tolerated but INTENDED: on a vendor-access row the actor is the vendor's
			// own user, who lives in the vendor tenant, and naming them is the whole
			// value of the row - "the platform owner opened my account at 14:02". It can
			// never be another CUSTOMER's user, because a customer's actions are only
			// ever recorded against their own tenant. Only the display name is selected.
			with: {
				user: {
					columns: { username: true, phone: true },
				},
			},
			orderBy: (t, { desc }) => [desc(t.createdAt)],
			limit,
			offset,
		}),
		db.select({ count: count() }).from(auditLogs).where(tenantWhereClause),
	]);

	const totalCount = Number(countResult[0]?.count ?? 0);
	const totalPages = Math.ceil(totalCount / limit);

	return c.json(
		{
			success: true as const,
			data: {
				items: items.map(toItem),
				meta: { total: totalCount, page, limit, totalPages },
			},
		},
		200
	);
};
