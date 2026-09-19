/**
 * The tenant's own staff list.
 *
 * EVERY statement here is filtered by the tenant on the token, and the tenant
 * comes from `currentTenantId(c)` - never from a path, a query or a body. A user
 * id belonging to another customer is answered with 404, not 403: a 403 confirms
 * the account exists somewhere, and "does +998 90 123 45 67 work here" is exactly
 * the question a competitor would ask.
 *
 * The ONE deliberately unscoped lookup is the phone-uniqueness probe in
 * updateHandler, and it is unscoped because the database says so: users.phone
 * carries a PLATFORM-WIDE unique index (users_phone_unique), because login is a
 * phone plus a password with no tenant field. See the comment there.
 */
import type { UserRoleType } from "@shared/types";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { operatorProfiles, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import { alreadyExists, notFound } from "@/lib/errors";
import { currentTenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";

import type { get, getMyProfile, list, remove, update } from "./users.routes";

const SUPERVISOR_ONLY: UserRoleType[] = ["supervisor", "admin"];

type Row = {
	id: string;
	phone: string;
	username: string | null;
	email: string | null;
	role: UserRoleType;
	isActive: boolean;
	isDeleted: boolean;
	createdAt: Date;
	updatedAt: Date;
};

function toJson(u: Row) {
	return {
		id: u.id,
		phone: u.phone,
		username: u.username,
		email: u.email,
		role: u.role,
		isActive: u.isActive,
		isDeleted: u.isDeleted,
		createdAt: u.createdAt.toISOString(),
		updatedAt: u.updatedAt.toISOString(),
	};
}

export const listHandler: AppRouteHandler<typeof list> = async (c) => {
	requireRoles(c, SUPERVISOR_ONLY);
	const tenantId = currentTenantId(c);
	const { page, limit, role } = c.req.valid("query");
	const offset = (page - 1) * limit;

	// The tenant leads the AND (matching idx_users_tenant_role), and the role filter
	// and the pagination window are applied INSIDE it - so no page, sort or filter
	// can walk out of the tenant.
	//
	// Named after the helper, not `where`: the ratchet in lib/tenancy/query-guard.ts
	// scans TEXT, and a tenant clause hidden behind a bare `where` reads to it as no
	// tenant at all.
	const tenantWhereClause = tenantWhere(
		users,
		tenantId,
		role ? eq(users.role, role) : undefined,
		eq(users.isDeleted, false)
	);

	const [items, [total]] = await Promise.all([
		db.query.users.findMany({
			where: tenantWhereClause,
			columns: {
				id: true,
				phone: true,
				username: true,
				email: true,
				role: true,
				isActive: true,
				isDeleted: true,
				createdAt: true,
				updatedAt: true,
			},
			orderBy: (t, { desc }) => [desc(t.createdAt)],
			limit,
			offset,
		}),
		// The count is the same WHERE as the page. An unscoped count would report the
		// platform's user total to every customer - a leak with no row in it.
		db
			.select({ count: count() })
			.from(users)
			.where(tenantWhereClause),
	]);

	const totalCount = Number(total?.count ?? 0);
	const totalPages = Math.ceil(totalCount / limit);

	return c.json(
		{
			success: true as const,
			data: {
				items: (items as Row[]).map(toJson),
				meta: { total: totalCount, page, limit, totalPages },
			},
		},
		200
	);
};

/**
 * Additive: joriy foydalanuvchining o'z profili.
 *
 * Rol tekshiruvi yo'q — token egasining faqat o'z yozuvi o'qiladi, shu sababli
 * manager ham o'z profilini ko'ra oladi. Operator profili majburiy emas:
 * bo'lmasa `operator: null` qaytadi (bu xato emas, shunchaki bu foydalanuvchi
 * operator emas).
 */
export const getMyProfileHandler: AppRouteHandler<typeof getMyProfile> = async (c) => {
	const authUser = c.get("user");
	const tenantId = currentTenantId(c);

	// Scoped even though the id comes from the token: the token's tenant and the
	// token's user must agree. If they ever did not - a token minted for the wrong
	// tenant - this answers 404 instead of serving a foreign profile.
	const row = await db.query.users.findFirst({
		where: tenantWhere(users, tenantId, eq(users.id, authUser.id)),
		columns: {
			id: true,
			phone: true,
			username: true,
			email: true,
			role: true,
			isActive: true,
			lastLoginAt: true,
			createdAt: true,
			updatedAt: true,
		},
	});

	if (!row) {
		throw notFound("Foydalanuvchi", authUser.id);
	}

	const operator = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			tenantId,
			eq(operatorProfiles.userId, authUser.id),
			eq(operatorProfiles.isDeleted, false)
		),
		columns: {
			id: true,
			extension: true,
			currentStatus: true,
			lastStatusChange: true,
			createdAt: true,
		},
	});

	return c.json(
		{
			success: true as const,
			data: {
				id: row.id,
				phone: row.phone,
				username: row.username,
				email: row.email,
				role: row.role,
				isActive: row.isActive,
				lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
				operator: operator
					? {
							id: operator.id,
							extension: operator.extension,
							currentStatus: operator.currentStatus,
							lastStatusChange: operator.lastStatusChange
								? operator.lastStatusChange.toISOString()
								: null,
							createdAt: operator.createdAt.toISOString(),
						}
					: null,
			},
		},
		200
	);
};

export const getHandler: AppRouteHandler<typeof get> = async (c) => {
	requireRoles(c, SUPERVISOR_ONLY);
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;
	const row = await db.query.users.findFirst({
		where: tenantWhere(users, tenantId, eq(users.id, id)),
		columns: {
			id: true,
			phone: true,
			username: true,
			email: true,
			role: true,
			isActive: true,
			isDeleted: true,
			createdAt: true,
			updatedAt: true,
		},
	});

	if (!row) {
		throw notFound("Foydalanuvchi", id);
	}

	return c.json({ success: true as const, data: toJson(row as Row) }, 200);
};

export const updateHandler: AppRouteHandler<typeof update> = async (c) => {
	requireRoles(c, SUPERVISOR_ONLY);
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;
	const body = c.req.valid("json");

	const existing = await db.query.users.findFirst({
		where: tenantWhere(users, tenantId, eq(users.id, id)),
	});
	if (!existing) {
		throw notFound("Foydalanuvchi", id);
	}

	if (body.phone && body.phone !== existing.phone) {
		// DELIBERATELY NOT tenant-scoped. users.phone has a platform-wide unique index
		// (users_phone_unique) because login has no tenant field, so the question here
		// is "is this login taken anywhere" - the same question the index asks. Scoping
		// it would turn a clean 409 into a unique-violation 500 the moment two
		// customers reached for the same number. What it discloses is only that a phone
		// is in use on the platform, which is the price of a platform-wide login
		// identity; it names no tenant, no user and no role.
		const other = await db.query.users.findFirst({
			where: eq(users.phone, body.phone),
		});
		if (other && !other.isDeleted) {
			throw alreadyExists("Foydalanuvchi", "telefon raqami");
		}
	}

	await db
		.update(users)
		.set({
			phone: body.phone ?? existing.phone,
			username: body.username ?? existing.username,
			email: body.email ?? existing.email,
			role: body.role ?? existing.role,
			isActive: body.isActive ?? existing.isActive,
		})
		// Scoped on the WRITE as well, not only on the read above: the row was already
		// proven to be this tenant's, and repeating the filter is what makes the UPDATE
		// itself incapable of touching another customer's account.
		.where(tenantWhere(users, tenantId, eq(users.id, id)));

	await audit(c, { action: "users.update", entityType: "user", entityId: id });

	const row = await db.query.users.findFirst({
		where: tenantWhere(users, tenantId, eq(users.id, id)),
		columns: {
			id: true,
			phone: true,
			username: true,
			email: true,
			role: true,
			isActive: true,
			isDeleted: true,
			createdAt: true,
			updatedAt: true,
		},
	});
	if (!row) {
		throw notFound("Foydalanuvchi", id);
	}

	return c.json({ success: true as const, data: toJson(row as Row) }, 200);
};

export const removeHandler: AppRouteHandler<typeof remove> = async (c) => {
	requireRoles(c, SUPERVISOR_ONLY);
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;

	// The tenant is part of the UPDATE, so another customer's id matches no row and
	// falls through to the 404 below - it is never soft-deleted first and refused
	// afterwards.
	const [u] = await db
		.update(users)
		.set({ isDeleted: true, isActive: false, deletedAt: new Date() })
		.where(tenantWhere(users, tenantId, eq(users.id, id)))
		.returning({ id: users.id });

	if (!u) {
		throw notFound("Foydalanuvchi", id);
	}

	await audit(c, { action: "users.remove", entityType: "user", entityId: id });

	return c.json({ success: true as const, data: { message: "O'chirildi" } }, 200);
};
