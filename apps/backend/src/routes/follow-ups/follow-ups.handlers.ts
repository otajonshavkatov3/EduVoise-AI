import type { TenantId, UserRoleType } from "@shared/types";
import { asc, count, desc, eq, gte, lt, lte, notInArray, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "@/db";
import type { FollowUpTaskRecord } from "@/db/schema";
import { calls, contacts, followUpTasks, operatorProfiles, tickets } from "@/db/schema";
import { audit } from "@/lib/audit";
import { businessError, databaseError, forbidden, notFound } from "@/lib/errors";
import { currentTenantId, tenantWhere } from "@/lib/tenancy";
import type { AppBindings, AppRouteHandler } from "@/lib/types";
import type * as r from "./follow-ups.routes";
import type { ListQuery } from "./follow-ups.schemas";

/** Admin va Supervisor barcha vazifalarni ko'radi/tahrirlaydi; manager faqat o'ziga biriktirilganini. */
const CAN_SEE_ALL_FOLLOW_UPS: UserRoleType[] = ["admin", "supervisor"];

/** Hech qachon mos kelmaydigan uuid — manager operator profiliga ega bo'lmaganda ishlatiladi. */
const MATCHES_NOTHING_UUID = "00000000-0000-0000-0000-000000000000";

type FollowUpStatus = "open" | "in_progress" | "done" | "cancelled";

/** Yopilgan hisoblanadigan statuslar (overdue hisobiga kirmaydi). */
const CLOSED_STATUSES: FollowUpStatus[] = ["done", "cancelled"];

/**
 * Ruxsat etilgan status o'tishlari. Bekor qilingan vazifa to'g'ridan-to'g'ri
 * "done" bo'lmaydi — avval qayta ochilishi kerak.
 */
const ALLOWED_TRANSITIONS = new Map<FollowUpStatus, FollowUpStatus[]>([
	["open", ["in_progress", "done", "cancelled"]],
	["in_progress", ["open", "done", "cancelled"]],
	["done", ["open", "in_progress", "cancelled"]],
	["cancelled", ["open"]],
]);

const withRelations = {
	with: {
		contact: {
			columns: {
				id: true,
				phoneNumber: true,
				firstName: true,
				lastName: true,
			},
		},
		assignee: {
			columns: {
				id: true,
				userId: true,
				extension: true,
			},
		},
	},
};

type ContactSummary = {
	id: string;
	phoneNumber: string;
	firstName: string | null;
	lastName: string | null;
};

type AssigneeSummary = {
	id: string;
	userId: string;
	extension: string;
};

type FollowUpRow = FollowUpTaskRecord & {
	contact?: ContactSummary | ContactSummary[] | null;
	assignee?: AssigneeSummary | AssigneeSummary[] | null;
};

function firstOrNull<T>(value: T | T[] | null | undefined): T | null {
	if (!value) {
		return null;
	}

	return Array.isArray(value) ? (value[0] ?? null) : value;
}

function toItem(row: FollowUpRow) {
	const contact = firstOrNull(row.contact);
	const assignee = firstOrNull(row.assignee);
	const status = row.status as FollowUpStatus;

	return {
		id: row.id,
		callId: row.callId,
		ticketId: row.ticketId,
		contactId: row.contactId,
		assignedTo: row.assignedTo,
		title: row.title,
		description: row.description,
		dueAt: row.dueAt?.toISOString() ?? null,
		status,
		createdBySystem: row.createdBySystem,
		isOverdue:
			row.dueAt !== null && !CLOSED_STATUSES.includes(status) && row.dueAt.getTime() < Date.now(),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		completedAt: row.completedAt?.toISOString() ?? null,
		contact: contact
			? {
					id: contact.id,
					phoneNumber: contact.phoneNumber,
					firstName: contact.firstName,
					lastName: contact.lastName,
				}
			: null,
		assignee: assignee
			? { id: assignee.id, userId: assignee.userId, extension: assignee.extension }
			: null,
	};
}

async function findMyOperatorProfileId(tenantId: TenantId, userId: string): Promise<string | null> {
	const [row] = await db
		.select({ id: operatorProfiles.id })
		.from(operatorProfiles)
		.where(
			tenantWhere(
				operatorProfiles,
				tenantId,
				eq(operatorProfiles.userId, userId),
				eq(operatorProfiles.isDeleted, false)
			)
		)
		.limit(1);

	return row?.id ?? null;
}

async function findWithRelations(tenantId: TenantId, id: string): Promise<FollowUpRow | undefined> {
	const row = await db.query.followUpTasks.findFirst({
		where: tenantWhere(followUpTasks, tenantId, eq(followUpTasks.id, id)),
		...withRelations,
	});

	return row as FollowUpRow | undefined;
}

/**
 * Bog'lanadigan yozuvlar mavjudligini tekshiradi (FK xatosi o'rniga tushunarli 404).
 *
 * PARENT OWNERSHIP, same rule as bookings: all three ids arrive in the request body
 * and every foreign key on this table is satisfied by a row from ANY tenant. The
 * tenant filter here is what makes "attach my task to your call" impossible.
 */
async function assertLinkedRecords(
	tenantId: TenantId,
	body: {
		callId?: string;
		ticketId?: string;
		contactId?: string;
	}
): Promise<void> {
	if (body.callId) {
		const [row] = await db
			.select({ id: calls.id })
			.from(calls)
			.where(tenantWhere(calls, tenantId, eq(calls.id, body.callId)))
			.limit(1);

		if (!row) {
			throw notFound("Qo'ng'iroq", body.callId);
		}
	}

	if (body.ticketId) {
		const [row] = await db
			.select({ id: tickets.id })
			.from(tickets)
			.where(
				tenantWhere(tickets, tenantId, eq(tickets.id, body.ticketId), eq(tickets.isDeleted, false))
			)
			.limit(1);

		if (!row) {
			throw notFound("Murojaat", body.ticketId);
		}
	}

	if (body.contactId) {
		const [row] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				tenantWhere(
					contacts,
					tenantId,
					eq(contacts.id, body.contactId),
					eq(contacts.isDeleted, false)
				)
			)
			.limit(1);

		if (!row) {
			throw notFound("Kontakt", body.contactId);
		}
	}
}

async function assertAssigneeExists(tenantId: TenantId, operatorProfileId: string): Promise<void> {
	const [row] = await db
		.select({ id: operatorProfiles.id })
		.from(operatorProfiles)
		.where(
			tenantWhere(
				operatorProfiles,
				tenantId,
				eq(operatorProfiles.id, operatorProfileId),
				eq(operatorProfiles.isDeleted, false)
			)
		)
		.limit(1);

	if (!row) {
		throw notFound("Operator profili", operatorProfileId);
	}
}

/**
 * Vazifani ko'rish/tahrirlash huquqi. Ruxsat bo'lmasa 404 — boshqa operatorning
 * vazifasi mavjudligini oshkor qilmaslik uchun (tickets.handlers.ts bilan bir xil).
 */
async function assertCanTouch(
	c: Context<AppBindings>,
	row: { id: string; assignedTo: string | null }
): Promise<void> {
	const user = c.get("user");

	if (CAN_SEE_ALL_FOLLOW_UPS.includes(user.role)) {
		return;
	}

	const myProfileId = await findMyOperatorProfileId(currentTenantId(c), user.id);

	if (!myProfileId || row.assignedTo !== myProfileId) {
		throw notFound("Keyingi aloqa vazifasi", row.id);
	}
}

/**
 * RBAC scope sharti: manager faqat o'ziga biriktirilganini ko'radi (profili
 * bo'lmasa — hech nimani), admin/supervisor esa xohlasa assignedTo bo'yicha filtrlaydi.
 */
async function resolveScopeCondition(
	c: Context<AppBindings>,
	requestedAssignedTo?: string
): Promise<SQL | undefined> {
	const user = c.get("user");

	if (CAN_SEE_ALL_FOLLOW_UPS.includes(user.role)) {
		return requestedAssignedTo ? eq(followUpTasks.assignedTo, requestedAssignedTo) : undefined;
	}

	const myProfileId = await findMyOperatorProfileId(currentTenantId(c), user.id);

	return eq(followUpTasks.assignedTo, myProfileId ?? MATCHES_NOTHING_UUID);
}

function buildFilterConditions(query: ListQuery): SQL[] {
	const conditions: SQL[] = [];

	if (query.status) {
		conditions.push(eq(followUpTasks.status, query.status));
	}
	if (query.contactId) {
		conditions.push(eq(followUpTasks.contactId, query.contactId));
	}
	if (query.callId) {
		conditions.push(eq(followUpTasks.callId, query.callId));
	}
	if (query.ticketId) {
		conditions.push(eq(followUpTasks.ticketId, query.ticketId));
	}
	if (query.dueFrom) {
		conditions.push(gte(followUpTasks.dueAt, new Date(query.dueFrom)));
	}
	if (query.dueTo) {
		conditions.push(lte(followUpTasks.dueAt, new Date(query.dueTo)));
	}
	if (query.overdue === "true") {
		// dueAt NULL bo'lgan qatorlar bu solishtirishdan o'tmaydi — muddati yo'q
		// vazifa "kechikkan" hisoblanmaydi.
		conditions.push(lt(followUpTasks.dueAt, new Date()));
		conditions.push(notInArray(followUpTasks.status, CLOSED_STATUSES));
	}
	if (query.createdBySystem) {
		conditions.push(eq(followUpTasks.createdBySystem, query.createdBySystem === "true"));
	}

	return conditions;
}

/** Yaratishda assignedTo: manager faqat o'ziga, admin/supervisor istalgan operatorga. */
async function resolveAssigneeForCreate(
	c: Context<AppBindings>,
	requested?: string
): Promise<string | null> {
	const user = c.get("user");
	const tenantId = currentTenantId(c);

	if (CAN_SEE_ALL_FOLLOW_UPS.includes(user.role)) {
		if (!requested) {
			return null;
		}

		await assertAssigneeExists(tenantId, requested);

		return requested;
	}

	const myProfileId = await findMyOperatorProfileId(tenantId, user.id);

	if (!myProfileId) {
		throw forbidden("Sizga operator profili biriktirilmagan, vazifa yaratib bo'lmaydi");
	}
	if (requested && requested !== myProfileId) {
		throw forbidden("Vazifani faqat o'zingizga biriktirishingiz mumkin");
	}

	return myProfileId;
}

/**
 * Tahrirlashda assignedTo o'zgarishi. Manager vazifani boshqa operatorga
 * o'tkaza olmaydi (aks holda o'zi ko'rmay qoladi va nazoratdan chiqadi).
 */
async function resolveAssigneeChange(
	c: Context<AppBindings>,
	requested: string | null | undefined,
	current: string | null
): Promise<{ changed: boolean; value: string | null }> {
	if (requested === undefined || requested === current) {
		return { changed: false, value: current };
	}

	const user = c.get("user");

	if (!CAN_SEE_ALL_FOLLOW_UPS.includes(user.role)) {
		throw forbidden("Vazifani boshqa operatorga biriktirish uchun ruxsat yo'q");
	}
	if (requested !== null) {
		await assertAssigneeExists(currentTenantId(c), requested);
	}

	return { changed: true, value: requested };
}

function assertTransition(from: FollowUpStatus, to: FollowUpStatus): void {
	const allowed = ALLOWED_TRANSITIONS.get(from) ?? [];

	if (!allowed.includes(to)) {
		throw businessError(`Statusni '${from}' dan '${to}' ga o'tkazish mumkin emas`, [
			{ field: "status", reason: `Ruxsat etilgan: ${allowed.join(", ")}` },
		]);
	}
}

export const listHandler: AppRouteHandler<typeof r.list> = async (c) => {
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query") as ListQuery;
	const { page, limit } = query;
	const offset = (page - 1) * limit;

	const conditions = buildFilterConditions(query);
	const scope = await resolveScopeCondition(c, query.assignedTo);

	if (scope) {
		conditions.push(scope);
	}

	// The RBAC scope narrows within a tenant; the tenant filter is the boundary.
	// Repeated at each statement so neither query depends on a line above it.
	const [items, countResult] = await Promise.all([
		db.query.followUpTasks.findMany({
			where: tenantWhere(followUpTasks, tenantId, ...conditions),
			...withRelations,
			// Muddati borlar avval (Postgres'da ASC — NULL'lar oxirida), keyin yangi yaratilganlar.
			orderBy: [asc(followUpTasks.dueAt), desc(followUpTasks.createdAt)],
			limit,
			offset,
		}),
		db
			.select({ count: count() })
			.from(followUpTasks)
			.where(tenantWhere(followUpTasks, tenantId, ...conditions)),
	]);

	const totalCount = Number(countResult[0]?.count ?? 0);
	const totalPages = Math.ceil(totalCount / limit);

	return c.json(
		{
			success: true as const,
			data: {
				items: (items as FollowUpRow[]).map(toItem),
				meta: { total: totalCount, page, limit, totalPages },
			},
		},
		200
	);
};

export const getHandler: AppRouteHandler<typeof r.get> = async (c) => {
	const id = c.req.valid("param").id;

	const row = await findWithRelations(currentTenantId(c), id);

	if (!row) {
		throw notFound("Keyingi aloqa vazifasi", id);
	}

	await assertCanTouch(c, { id: row.id, assignedTo: row.assignedTo });

	return c.json({ success: true as const, data: toItem(row) }, 200);
};

export const createHandler: AppRouteHandler<typeof r.create> = async (c) => {
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");

	await assertLinkedRecords(tenantId, body);

	const assignedTo = await resolveAssigneeForCreate(c, body.assignedTo);

	const [inserted] = await db
		.insert(followUpTasks)
		.values({
			tenantId,
			callId: body.callId ?? null,
			ticketId: body.ticketId ?? null,
			contactId: body.contactId ?? null,
			assignedTo,
			title: body.title,
			description: body.description ?? null,
			dueAt: body.dueAt ? new Date(body.dueAt) : null,
			// API orqali kelgan vazifa — odam yaratgan, AI emas.
			createdBySystem: false,
		})
		.returning({ id: followUpTasks.id });

	if (!inserted) {
		throw databaseError("Follow-up vazifani yozish natija qaytarmadi");
	}

	const row = await findWithRelations(tenantId, inserted.id);

	if (!row) {
		throw notFound("Keyingi aloqa vazifasi", inserted.id);
	}

	await audit(c, {
		action: "follow-ups.create",
		entityType: "follow_up_task",
		entityId: inserted.id,
		details: {
			assignedTo,
			dueAt: row.dueAt?.toISOString() ?? null,
			callId: row.callId,
			ticketId: row.ticketId,
			contactId: row.contactId,
		},
	});

	return c.json({ success: true as const, data: toItem(row) }, 201);
};

export const updateHandler: AppRouteHandler<typeof r.update> = async (c) => {
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;
	const body = c.req.valid("json");

	const existing = await findWithRelations(tenantId, id);

	if (!existing) {
		throw notFound("Keyingi aloqa vazifasi", id);
	}

	await assertCanTouch(c, { id: existing.id, assignedTo: existing.assignedTo });

	const currentStatus = existing.status as FollowUpStatus;
	const updates: {
		title?: string;
		description?: string | null;
		dueAt?: Date | null;
		status?: FollowUpStatus;
		assignedTo?: string | null;
		completedAt?: Date | null;
		updatedAt: Date;
	} = { updatedAt: new Date() };

	if (body.title !== undefined) {
		updates.title = body.title;
	}
	if (body.description !== undefined) {
		updates.description = body.description;
	}
	if (body.dueAt !== undefined) {
		updates.dueAt = body.dueAt === null ? null : new Date(body.dueAt);
	}

	const assignee = await resolveAssigneeChange(c, body.assignedTo, existing.assignedTo);

	if (assignee.changed) {
		updates.assignedTo = assignee.value;
	}

	if (body.status !== undefined && body.status !== currentStatus) {
		assertTransition(currentStatus, body.status);
		updates.status = body.status;

		if (body.status === "done") {
			updates.completedAt = new Date();
		} else if (currentStatus === "done") {
			// done'dan chiqarilganda bajarilgan vaqti endi to'g'ri emas.
			updates.completedAt = null;
		}
	}

	await db
		.update(followUpTasks)
		.set(updates)
		.where(tenantWhere(followUpTasks, tenantId, eq(followUpTasks.id, id)));

	const updated = await findWithRelations(tenantId, id);

	if (!updated) {
		throw notFound("Keyingi aloqa vazifasi", id);
	}

	await audit(c, {
		action: "follow-ups.update",
		entityType: "follow_up_task",
		entityId: id,
		details: {
			fields: Object.keys(updates).filter((field) => field !== "updatedAt"),
			previousStatus: currentStatus,
			status: updated.status,
			previousAssignedTo: existing.assignedTo,
			assignedTo: updated.assignedTo,
		},
	});

	return c.json({ success: true as const, data: toItem(updated) }, 200);
};

export const removeHandler: AppRouteHandler<typeof r.remove> = async (c) => {
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;

	const [existing] = await db
		.select({
			id: followUpTasks.id,
			assignedTo: followUpTasks.assignedTo,
			status: followUpTasks.status,
		})
		.from(followUpTasks)
		.where(tenantWhere(followUpTasks, tenantId, eq(followUpTasks.id, id)))
		.limit(1);

	if (!existing) {
		throw notFound("Keyingi aloqa vazifasi", id);
	}

	await assertCanTouch(c, { id: existing.id, assignedTo: existing.assignedTo });

	if (existing.status === "cancelled") {
		return c.json({ success: true as const, data: { message: "Allaqachon bekor qilingan" } }, 200);
	}

	// Hard delete yo'q: vazifa tarixi hisobotlarda qoladi.
	await db
		.update(followUpTasks)
		.set({ status: "cancelled", completedAt: null, updatedAt: new Date() })
		.where(tenantWhere(followUpTasks, tenantId, eq(followUpTasks.id, id)));

	await audit(c, {
		action: "follow-ups.cancel",
		entityType: "follow_up_task",
		entityId: id,
		details: { previousStatus: existing.status, status: "cancelled" },
	});

	return c.json({ success: true as const, data: { message: "Bekor qilindi" } }, 200);
};
