/**
 * The tenant's operators - the thing a customer buys the platform to create.
 *
 * DECISION #1 LIVES HERE. Extension digits are an operator CODE, not an address:
 * two customers will both have a "101" and both must keep it. The database says so
 * with UNIQUE (tenant_id, extension), so every uniqueness probe below is scoped to
 * the tenant. A platform-wide probe would have told the second customer their own
 * numbering scheme was "already taken" by a business they cannot see.
 *
 * PARENT OWNERSHIP is checked, not assumed: createHandler resolves the userId from
 * the body INSIDE the caller's tenant, so a supervisor cannot attach an operator
 * profile to another customer's user by pasting its id.
 */
import type { UserRoleType } from "@shared/types";
import { count, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { operatorProfiles, operatorStatusLogs, users } from "@/db/schema";
import { operatorWebSipIdentity } from "@/lib/asterisk";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import { alreadyExists, conflict, notFound } from "@/lib/errors";
import { currentTenantId, getTenantById, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import type {
	create,
	get,
	getMe,
	getMeSip,
	list,
	remove,
	update,
	updateMeStatus,
} from "./operator-profiles.routes";

/** Where the dashboard softphone opens its SIP-over-WebSocket link. */
const SIP_WS_URL = process.env.VITE_SIP_WS_URL?.trim() || "ws://localhost:8088/ws";

/** The SIP domain operators register against - explicit, else the WS host. */
function sipRealm(): string {
	const explicit = process.env.VITE_SIP_REALM?.trim();

	if (explicit) {
		return explicit;
	}

	try {
		return new URL(SIP_WS_URL).hostname || "localhost";
	} catch {
		return "localhost";
	}
}

/** Roles that can create/update/remove operator profiles and change status */
const ALLOWED_MANAGER_ROLES: UserRoleType[] = ["supervisor"];

/**
 * The joined user. This side of the join carries no tenant term of its own - drizzle
 * follows the foreign key - so it is only safe because the PROFILE is scoped and its
 * user_id was resolved inside the same tenant when the profile was created (see
 * createHandler). That is the "one side scoped, one side not" shape, written down
 * rather than left to be noticed: if a profile could ever point at a foreign user,
 * this join would expose that user's phone.
 */
const withUser = {
	with: { user: { columns: { id: true, phone: true, role: true } } },
};
const cols = {
	id: operatorProfiles.id,
	userId: operatorProfiles.userId,
	extension: operatorProfiles.extension,
	currentStatus: operatorProfiles.currentStatus,
	lastStatusChange: operatorProfiles.lastStatusChange,
	isDeleted: operatorProfiles.isDeleted,
	createdAt: operatorProfiles.createdAt,
};

type Row = {
	id: string;
	userId: string;
	extension: string;
	currentStatus: "online" | "offline" | "pause" | "busy";
	lastStatusChange: Date | null;
	isDeleted: boolean;
	createdAt: Date;
	user?:
		| { id: string; phone: string; role: string }
		| { id: string; phone: string; role: string }[]
		| null;
};

type Status = "online" | "offline" | "pause" | "busy";

/**
 * "Is this extension free?" - asked INSIDE one tenant, because that is the question
 * the unique index answers (UNIQUE (tenant_id, extension)). Asking it platform-wide
 * would reject a number another customer happens to use.
 */
async function ensureExtensionUnique(tenantId: TenantId, id: string, extension: string) {
	const ext = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			tenantId,
			eq(operatorProfiles.extension, extension),
			eq(operatorProfiles.isDeleted, false)
		),
	});
	if (ext && ext.id !== id) {
		throw alreadyExists("Operator profili", "ichki raqam");
	}
}

async function closePreviousStatusLogAndCreateNew(
	tenantId: TenantId,
	operatorId: string,
	status: Status,
	now: Date
) {
	const openLog = await db.query.operatorStatusLogs.findFirst({
		where: tenantWhere(
			operatorStatusLogs,
			tenantId,
			eq(operatorStatusLogs.operatorId, operatorId),
			isNull(operatorStatusLogs.endedAt)
		),
		orderBy: (t, { desc }) => [desc(t.startedAt)],
	});
	if (openLog) {
		const startedAt =
			openLog.startedAt instanceof Date ? openLog.startedAt : new Date(openLog.startedAt);
		const durationSec = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
		await db
			.update(operatorStatusLogs)
			.set({ endedAt: now, duration: durationSec })
			.where(tenantWhere(operatorStatusLogs, tenantId, eq(operatorStatusLogs.id, openLog.id)));
	}
	await db.insert(operatorStatusLogs).values({ tenantId, operatorId, status, startedAt: now });
}

function toJson(p: Row) {
	const u = p.user;
	const one = u ? (Array.isArray(u) ? u[0] : u) : undefined;
	return {
		id: p.id,
		userId: p.userId,
		extension: p.extension,
		currentStatus: p.currentStatus,
		lastStatusChange: p.lastStatusChange?.toISOString() ?? null,
		isDeleted: p.isDeleted,
		createdAt: p.createdAt.toISOString(),
		user: one ? { id: one.id, phone: one.phone, role: one.role } : undefined,
	};
}

export const listHandler: AppRouteHandler<typeof list> = async (c) => {
	const tenantId = currentTenantId(c);
	const { page, limit, includeDeleted } = c.req.valid("query");
	const offset = (page - 1) * limit;
	// includeDeleted widens WHAT is listed, never WHOSE: the tenant stays in the AND.
	//
	// Named after the helper, not `where`: the ratchet in lib/tenancy/query-guard.ts
	// scans TEXT, and a tenant clause hidden behind a bare `where` reads to it as no
	// tenant at all.
	const tenantWhereClause = tenantWhere(
		operatorProfiles,
		tenantId,
		includeDeleted === "true" ? undefined : eq(operatorProfiles.isDeleted, false)
	);

	// Same WHERE as the page, so the total cannot count another tenant's operators.
	const countQuery = db.select({ count: count() }).from(operatorProfiles).where(tenantWhereClause);

	const [items, [total]] = await Promise.all([
		db.query.operatorProfiles.findMany({
			where: tenantWhereClause,
			columns: {
				id: true,
				userId: true,
				extension: true,
				currentStatus: true,
				lastStatusChange: true,
				isDeleted: true,
				createdAt: true,
			},
			...withUser,
			orderBy: (t, { desc }) => [desc(t.createdAt)],
			limit,
			offset,
		}),
		countQuery,
	]);

	const totalCount = Number(total?.count ?? 0);
	const totalPages = Math.ceil(totalCount / limit);

	return c.json(
		{
			success: true as const,
			data: {
				items: (items as Row[]).map(toJson),
				meta: {
					total: totalCount,
					page,
					limit,
					totalPages,
				},
			},
		},
		200
	);
};

export const getHandler: AppRouteHandler<typeof get> = async (c) => {
	const row = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			currentTenantId(c),
			eq(operatorProfiles.id, c.req.valid("param").id)
		),
		columns: {
			id: true,
			userId: true,
			extension: true,
			currentStatus: true,
			lastStatusChange: true,
			isDeleted: true,
			createdAt: true,
		},
		...withUser,
	});
	if (!row) {
		throw notFound("Operator profili", c.req.valid("param").id);
	}
	return c.json({ success: true as const, data: toJson(row as Row) }, 200);
};

export const getMeHandler: AppRouteHandler<typeof getMe> = async (c) => {
	const user = c.get("user");
	const row = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			currentTenantId(c),
			eq(operatorProfiles.userId, user.id),
			eq(operatorProfiles.isDeleted, false)
		),
		columns: {
			id: true,
			userId: true,
			extension: true,
			currentStatus: true,
			lastStatusChange: true,
			isDeleted: true,
			createdAt: true,
		},
		...withUser,
	});
	if (!row) {
		throw notFound("Operator profili", user.id);
	}
	return c.json({ success: true as const, data: toJson(row as Row) }, 200);
};

export const getMeSipHandler: AppRouteHandler<typeof getMeSip> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);

	const row = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			tenantId,
			eq(operatorProfiles.userId, user.id),
			eq(operatorProfiles.isDeleted, false)
		),
		columns: { extension: true },
	});

	if (!row) {
		throw notFound("Operator profili", user.id);
	}

	// The endpoint names carry the slug (avilab-202), so the browser must register as
	// this tenant's own endpoint; the slug comes from the tenant row.
	const tenant = await getTenantById(tenantId);
	const slug = tenant?.slug ?? null;

	if (slug === null) {
		throw conflict("Ijarachi (tenant) nomi aniqlanmadi");
	}

	const identity = operatorWebSipIdentity(slug, row.extension);

	if (identity === null) {
		// Only 1XX desk extensions have a paired browser softphone; anything else
		// (e.g. 991) has no web endpoint to register.
		throw conflict("Bu operator uchun brauzer telefoni (web SIP) mavjud emas");
	}

	return c.json(
		{
			success: true as const,
			data: {
				deskExtension: row.extension,
				webExtension: identity.webExtension,
				sipUsername: identity.sipUsername,
				sipPassword: identity.sipPassword,
				wsUrl: SIP_WS_URL,
				realm: sipRealm(),
			},
		},
		200
	);
};

export const createHandler: AppRouteHandler<typeof create> = async (c) => {
	requireRoles(c, ALLOWED_MANAGER_ROLES);
	const tenantId = currentTenantId(c);
	const { userId, extension } = c.req.valid("json");

	// THE PARENT CHECK. userId arrives in the BODY, which is client input, so it is
	// resolved inside the caller's own tenant. Without the tenant term a supervisor
	// could paste another customer's user id and create a profile - and an operator
	// row pointing at a foreign user is a cross-tenant write the foreign key would
	// happily allow. Another tenant's id is 404: the same answer as an id that does
	// not exist, because "this uuid is somebody's user" is itself information.
	const [user] = await db
		.select()
		.from(users)
		.where(tenantWhere(users, tenantId, eq(users.id, userId)))
		.limit(1);
	if (!user) {
		throw notFound("Foydalanuvchi", userId);
	}
	const exists = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			tenantId,
			eq(operatorProfiles.extension, extension),
			eq(operatorProfiles.isDeleted, false)
		),
	});
	if (exists) {
		throw alreadyExists("Operator profili", "ichki raqam");
	}
	const byUser = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.userId, userId)),
	});
	if (byUser && !byUser.isDeleted) {
		throw conflict("Bu foydalanuvchida operator profili allaqachon bor");
	}

	const [inserted] = await db
		.insert(operatorProfiles)
		.values({ tenantId, userId, extension })
		.returning(cols);
	if (!inserted) {
		throw notFound("Operator profili", "insert");
	}
	// TZ: operator_status_logs — profil yaratilganda default "offline" holati logga yoziladi
	await db.insert(operatorStatusLogs).values({
		tenantId,
		operatorId: inserted.id,
		status: "offline",
		startedAt: inserted.createdAt ?? new Date(),
	});
	const row = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.id, inserted.id)),
		columns: {
			id: true,
			userId: true,
			extension: true,
			currentStatus: true,
			lastStatusChange: true,
			isDeleted: true,
			createdAt: true,
		},
		...withUser,
	});
	if (!row) {
		throw notFound("Operator profili", inserted.id);
	}
	await audit(c, {
		action: "operator_profiles.create",
		entityType: "operator_profile",
		entityId: inserted.id,
	});
	return c.json({ success: true as const, data: toJson(row as Row) }, 201);
};

export const updateHandler: AppRouteHandler<typeof update> = async (c) => {
	requireRoles(c, ALLOWED_MANAGER_ROLES);
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;
	const body = c.req.valid("json");
	const row = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.id, id)),
	});
	if (!row) {
		throw notFound("Operator profili", id);
	}
	if (body.extension !== undefined) {
		await ensureExtensionUnique(tenantId, id, body.extension);
	}

	const now = new Date();
	const set: {
		extension?: string;
		currentStatus?: Status;
		lastStatusChange?: Date;
	} = {};
	if (body.extension !== undefined) {
		set.extension = body.extension;
	}
	if (body.status !== undefined) {
		set.currentStatus = body.status as Status;
		set.lastStatusChange = now;
	}
	if (Object.keys(set).length > 0) {
		await db
			.update(operatorProfiles)
			.set(set)
			.where(tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.id, id)));
		if (body.status !== undefined) {
			await closePreviousStatusLogAndCreateNew(tenantId, id, body.status as Status, now);
		}
	}

	const updated = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.id, id)),
		columns: {
			id: true,
			userId: true,
			extension: true,
			currentStatus: true,
			lastStatusChange: true,
			isDeleted: true,
			createdAt: true,
		},
		...withUser,
	});
	if (!updated) {
		throw notFound("Operator profili", id);
	}
	await audit(c, {
		action: "operator_profiles.update",
		entityType: "operator_profile",
		entityId: id,
	});
	return c.json({ success: true as const, data: toJson(updated as Row) }, 200);
};

export const updateMeStatusHandler: AppRouteHandler<typeof updateMeStatus> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");

	const row = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			tenantId,
			eq(operatorProfiles.userId, user.id),
			eq(operatorProfiles.isDeleted, false)
		),
	});
	if (!row) {
		throw notFound("Operator profili", user.id);
	}

	const now = new Date();
	await db
		.update(operatorProfiles)
		.set({
			currentStatus: body.status as Status,
			lastStatusChange: now,
		})
		.where(tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.id, row.id)));

	await closePreviousStatusLogAndCreateNew(tenantId, row.id, body.status as Status, now);

	const updated = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.id, row.id)),
		columns: {
			id: true,
			userId: true,
			extension: true,
			currentStatus: true,
			lastStatusChange: true,
			isDeleted: true,
			createdAt: true,
		},
		...withUser,
	});

	if (!updated) {
		throw notFound("Operator profili", row.id);
	}

	return c.json({ success: true as const, data: toJson(updated as Row) }, 200);
};

export const removeHandler: AppRouteHandler<typeof remove> = async (c) => {
	requireRoles(c, ALLOWED_MANAGER_ROLES);
	const id = c.req.valid("param").id;
	const [r] = await db
		.update(operatorProfiles)
		.set({ isDeleted: true, deletedAt: new Date() })
		// Another tenant's id matches nothing and becomes the 404 below - it is never
		// deleted first and refused afterwards.
		.where(tenantWhere(operatorProfiles, currentTenantId(c), eq(operatorProfiles.id, id)))
		.returning({ id: operatorProfiles.id });
	if (!r) {
		throw notFound("Operator profili", id);
	}
	await audit(c, {
		action: "operator_profiles.remove",
		entityType: "operator_profile",
		entityId: id,
	});
	return c.json({ success: true as const, data: { message: "O'chirildi" } }, 200);
};
