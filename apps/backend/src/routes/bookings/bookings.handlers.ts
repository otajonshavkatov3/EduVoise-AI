import type { TenantId, UserRoleType } from "@shared/types";
import { asc, count, eq, gte, lt, lte, ne, type SQL, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "@/db";
import type { BookingRecord } from "@/db/schema";
import { bookings, calls, contacts, operatorProfiles, tickets } from "@/db/schema";
import { audit } from "@/lib/audit";
import {
	businessError,
	conflict,
	databaseError,
	forbidden,
	invalidInput,
	notFound,
} from "@/lib/errors";
import { currentTenantId, tenantWhere } from "@/lib/tenancy";
import type { AppBindings, AppRouteHandler } from "@/lib/types";
import type * as r from "./bookings.routes";
import type { ListQuery, UpdateBody } from "./bookings.schemas";

/** Admin va Supervisor barcha uchrashuvlarni ko'radi/tahrirlaydi; manager faqat o'ziga biriktirilganini. */
const CAN_SEE_ALL_BOOKINGS: UserRoleType[] = ["admin", "supervisor"];

/** Hech qachon mos kelmaydigan uuid — manager operator profiliga ega bo'lmaganda ishlatiladi. */
const MATCHES_NOTHING_UUID = "00000000-0000-0000-0000-000000000000";

/** Klient soati bilan farqni kechirish uchun (1 daqiqa) — "hozir" ga qo'yilgan uchrashuv o'tgan hisoblanmaydi. */
const PAST_TOLERANCE_MS = 60_000;

/** Kalendar bir oy/hafta uchun shuncha qatordan ko'p yubormaydi. */
const CALENDAR_ROW_LIMIT = 2000;

const MINUTE_MS = 60_000;
const DAY_KEY_LENGTH = 10;

type BookingStatus = "scheduled" | "confirmed" | "cancelled" | "completed";

/**
 * Ruxsat etilgan status o'tishlari. Bekor qilingan uchrashuv to'g'ridan-to'g'ri
 * "completed" bo'lmaydi — avval qayta rejalashtirilishi kerak.
 */
const ALLOWED_TRANSITIONS = new Map<BookingStatus, BookingStatus[]>([
	["scheduled", ["confirmed", "cancelled", "completed"]],
	["confirmed", ["scheduled", "cancelled", "completed"]],
	["cancelled", ["scheduled"]],
	["completed", ["confirmed"]],
]);

/** Uchrashuv yaratilganda standart davomiylik (bookings.duration_minutes default'i bilan bir xil). */
const DEFAULT_DURATION_MINUTES = 30;

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

type BookingRow = BookingRecord & {
	contact?: ContactSummary | ContactSummary[] | null;
	assignee?: AssigneeSummary | AssigneeSummary[] | null;
};

function firstOrNull<T>(value: T | T[] | null | undefined): T | null {
	if (!value) {
		return null;
	}

	return Array.isArray(value) ? (value[0] ?? null) : value;
}

function toItem(row: BookingRow) {
	const contact = firstOrNull(row.contact);
	const assignee = firstOrNull(row.assignee);

	return {
		id: row.id,
		contactId: row.contactId,
		callId: row.callId,
		ticketId: row.ticketId,
		assignedTo: row.assignedTo,
		title: row.title,
		notes: row.notes,
		scheduledAt: row.scheduledAt.toISOString(),
		endsAt: new Date(row.scheduledAt.getTime() + row.durationMinutes * MINUTE_MS).toISOString(),
		durationMinutes: row.durationMinutes,
		location: row.location,
		status: row.status as BookingStatus,
		createdBySystem: row.createdBySystem,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
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

async function findWithRelations(tenantId: TenantId, id: string): Promise<BookingRow | undefined> {
	const row = await db.query.bookings.findFirst({
		where: tenantWhere(bookings, tenantId, eq(bookings.id, id)),
		...withRelations,
	});

	return row as BookingRow | undefined;
}

/**
 * Bog'lanadigan yozuvlar mavjudligini tekshiradi (FK xatosi o'rniga tushunarli 404).
 *
 * PARENT OWNERSHIP. These three ids come from the request BODY. The foreign keys
 * are satisfied by any contact/call/ticket on the platform, so without the tenant
 * filter a caller could hang their booking off another customer's call - and the
 * booking's own relations would then read that row back out. "Not in your tenant"
 * is reported as 404, exactly like "does not exist".
 */
async function assertLinkedRecords(
	tenantId: TenantId,
	body: {
		contactId?: string;
		callId?: string;
		ticketId?: string;
	}
): Promise<void> {
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
 * Uchrashuvni ko'rish/tahrirlash huquqi. Ruxsat bo'lmasa 404 — boshqa operatorning
 * uchrashuvi mavjudligini oshkor qilmaslik uchun.
 */
async function assertCanTouch(
	c: Context<AppBindings>,
	row: { id: string; assignedTo: string | null }
): Promise<void> {
	const user = c.get("user");

	if (CAN_SEE_ALL_BOOKINGS.includes(user.role)) {
		return;
	}

	const myProfileId = await findMyOperatorProfileId(currentTenantId(c), user.id);

	if (!myProfileId || row.assignedTo !== myProfileId) {
		throw notFound("Uchrashuv", row.id);
	}
}

function assertNotInPast(scheduledAt: Date): void {
	if (scheduledAt.getTime() < Date.now() - PAST_TOLERANCE_MS) {
		throw businessError("O'tgan vaqtga uchrashuv belgilanmaydi", [
			{ field: "scheduledAt", reason: `Hozirgi vaqt: ${new Date().toISOString()}` },
		]);
	}
}

/**
 * Bir xodimda vaqt oralig'i kesishadigan uchrashuvni topadi.
 *
 * Kesishish sharti: mavjud.scheduledAt < yangi.tugash VA
 * mavjud.scheduledAt + davomiylik > yangi.boshlanish. Bekor qilinganlar hisobga olinmaydi.
 */
async function findOverlappingBooking(
	tenantId: TenantId,
	input: {
		assignedTo: string;
		scheduledAt: Date;
		durationMinutes: number;
		excludeId?: string;
	}
): Promise<{ id: string; title: string; scheduledAt: Date; durationMinutes: number } | null> {
	const endsAt = new Date(input.scheduledAt.getTime() + input.durationMinutes * MINUTE_MS);

	const conditions = [
		eq(bookings.assignedTo, input.assignedTo),
		ne(bookings.status, "cancelled"),
		lt(bookings.scheduledAt, endsAt),
		sql`${bookings.scheduledAt} + (${bookings.durationMinutes} * interval '1 minute') > ${input.scheduledAt}`,
	];

	if (input.excludeId) {
		conditions.push(ne(bookings.id, input.excludeId));
	}

	const [row] = await db
		.select({
			id: bookings.id,
			title: bookings.title,
			scheduledAt: bookings.scheduledAt,
			durationMinutes: bookings.durationMinutes,
		})
		.from(bookings)
		// The clash this finds is put in the error message, TITLE INCLUDED. Unscoped it
		// would both refuse a free slot because of a stranger's calendar and read that
		// stranger's appointment title back to the caller.
		.where(tenantWhere(bookings, tenantId, ...conditions))
		.orderBy(asc(bookings.scheduledAt))
		.limit(1);

	return row ?? null;
}

function doubleBookingError(clash: {
	id: string;
	title: string;
	scheduledAt: Date;
	durationMinutes: number;
}) {
	return conflict("Tanlangan xodimda bu vaqt oralig'ida boshqa uchrashuv bor", [
		{
			field: "scheduledAt",
			reason: `${clash.title} — ${clash.scheduledAt.toISOString()} (${clash.durationMinutes} daqiqa), id: ${clash.id}`,
		},
	]);
}

/** Xodim biriktirilgan bo'lsa, vaqt oralig'i bo'shligini talab qiladi. */
async function assertSlotIsFree(
	tenantId: TenantId,
	input: {
		assignedTo: string | null;
		scheduledAt: Date;
		durationMinutes: number;
		excludeId?: string;
	}
): Promise<void> {
	// Xodim biriktirilmagan uchrashuvda kesishishni tekshirishning ma'nosi yo'q.
	if (!input.assignedTo) {
		return;
	}

	const clash = await findOverlappingBooking(tenantId, {
		assignedTo: input.assignedTo,
		scheduledAt: input.scheduledAt,
		durationMinutes: input.durationMinutes,
		excludeId: input.excludeId,
	});

	if (clash) {
		throw doubleBookingError(clash);
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

	if (CAN_SEE_ALL_BOOKINGS.includes(user.role)) {
		return requestedAssignedTo ? eq(bookings.assignedTo, requestedAssignedTo) : undefined;
	}

	const myProfileId = await findMyOperatorProfileId(currentTenantId(c), user.id);

	return eq(bookings.assignedTo, myProfileId ?? MATCHES_NOTHING_UUID);
}

function buildFilterConditions(query: ListQuery): SQL[] {
	const conditions: SQL[] = [];

	if (query.status) {
		conditions.push(eq(bookings.status, query.status));
	}
	if (query.contactId) {
		conditions.push(eq(bookings.contactId, query.contactId));
	}
	if (query.callId) {
		conditions.push(eq(bookings.callId, query.callId));
	}
	if (query.ticketId) {
		conditions.push(eq(bookings.ticketId, query.ticketId));
	}
	if (query.from) {
		conditions.push(gte(bookings.scheduledAt, new Date(query.from)));
	}
	if (query.to) {
		conditions.push(lte(bookings.scheduledAt, new Date(query.to)));
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

	if (CAN_SEE_ALL_BOOKINGS.includes(user.role)) {
		if (!requested) {
			return null;
		}

		await assertAssigneeExists(tenantId, requested);

		return requested;
	}

	const myProfileId = await findMyOperatorProfileId(tenantId, user.id);

	if (!myProfileId) {
		throw forbidden("Sizga operator profili biriktirilmagan, uchrashuv yaratib bo'lmaydi");
	}
	if (requested && requested !== myProfileId) {
		throw forbidden("Uchrashuvni faqat o'zingizga biriktirishingiz mumkin");
	}

	return myProfileId;
}

/**
 * Tahrirlashda assignedTo o'zgarishi. Manager uchrashuvni boshqa operatorga
 * o'tkaza olmaydi (aks holda o'zi ko'rmay qoladi).
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

	if (!CAN_SEE_ALL_BOOKINGS.includes(user.role)) {
		throw forbidden("Uchrashuvni boshqa operatorga biriktirish uchun ruxsat yo'q");
	}
	if (requested !== null) {
		await assertAssigneeExists(currentTenantId(c), requested);
	}

	return { changed: true, value: requested };
}

function assertTransition(from: BookingStatus, to: BookingStatus): void {
	const allowed = ALLOWED_TRANSITIONS.get(from) ?? [];

	if (!allowed.includes(to)) {
		throw businessError(`Statusni '${from}' dan '${to}' ga o'tkazish mumkin emas`, [
			{ field: "status", reason: `Ruxsat etilgan: ${allowed.join(", ")}` },
		]);
	}
}

type BookingUpdates = {
	title?: string;
	notes?: string | null;
	scheduledAt?: Date;
	durationMinutes?: number;
	location?: string | null;
	status?: BookingStatus;
	assignedTo?: string | null;
	updatedAt: Date;
};

/** Qo'shimcha qoidasi yo'q maydonlar (vaqt, status va biriktirish alohida ishlanadi). */
function collectPlainUpdates(body: UpdateBody): BookingUpdates {
	const updates: BookingUpdates = { updatedAt: new Date() };

	if (body.title !== undefined) {
		updates.title = body.title;
	}
	if (body.notes !== undefined) {
		updates.notes = body.notes;
	}
	if (body.location !== undefined) {
		updates.location = body.location;
	}
	if (body.durationMinutes !== undefined) {
		updates.durationMinutes = body.durationMinutes;
	}

	return updates;
}

/** ISO satrni Date'ga aylantiradi (zod formatni tekshirgan, bu — oxirgi himoya). */
function parseScheduledAt(value: string): Date {
	const scheduledAt = new Date(value);

	if (Number.isNaN(scheduledAt.getTime())) {
		throw invalidInput("scheduledAt", "Vaqt ISO formatida bo'lishi kerak");
	}

	return scheduledAt;
}

function utcDayKey(date: Date): string {
	return date.toISOString().slice(0, DAY_KEY_LENGTH);
}

function monthRangeUtc(anchor: Date): { from: Date; to: Date } {
	return {
		from: new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)),
		to: new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1)),
	};
}

function weekRangeUtc(anchor: Date): { from: Date; to: Date } {
	// Dushanba — hafta boshi (getUTCDay: yakshanba = 0).
	const weekdayFromMonday = (anchor.getUTCDay() + 6) % 7;
	const from = new Date(
		Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() - weekdayFromMonday)
	);
	const to = new Date(from.getTime());
	to.setUTCDate(to.getUTCDate() + 7);

	return { from, to };
}

function dayKeysBetween(from: Date, to: Date): string[] {
	const keys: string[] = [];
	const cursor = new Date(from.getTime());

	while (cursor.getTime() < to.getTime()) {
		keys.push(utcDayKey(cursor));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}

	return keys;
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

	// The RBAC scope narrows within a tenant; the tenant filter is what makes it a
	// boundary. Both are applied, and the tenant one is not optional. Repeated at
	// each statement so no query here reads as scoped because of a line above it.
	const [items, countResult] = await Promise.all([
		db.query.bookings.findMany({
			where: tenantWhere(bookings, tenantId, ...conditions),
			...withRelations,
			orderBy: [asc(bookings.scheduledAt)],
			limit,
			offset,
		}),
		db
			.select({ count: count() })
			.from(bookings)
			.where(tenantWhere(bookings, tenantId, ...conditions)),
	]);

	const totalCount = Number(countResult[0]?.count ?? 0);
	const totalPages = Math.ceil(totalCount / limit);

	return c.json(
		{
			success: true as const,
			data: {
				items: (items as BookingRow[]).map(toItem),
				meta: { total: totalCount, page, limit, totalPages },
			},
		},
		200
	);
};

export const calendarHandler: AppRouteHandler<typeof r.calendar> = async (c) => {
	const tenantId = currentTenantId(c);
	const { view, date, status, assignedTo } = c.req.valid("query");

	const anchor = date ? new Date(`${date}T00:00:00.000Z`) : new Date();

	if (Number.isNaN(anchor.getTime())) {
		throw invalidInput("date", "Sana YYYY-MM-DD formatida va haqiqiy bo'lishi kerak");
	}

	const { from, to } = view === "week" ? weekRangeUtc(anchor) : monthRangeUtc(anchor);

	const conditions = [gte(bookings.scheduledAt, from), lt(bookings.scheduledAt, to)];
	const scope = await resolveScopeCondition(c, assignedTo);

	if (scope) {
		conditions.push(scope);
	}
	if (status) {
		conditions.push(eq(bookings.status, status));
	}

	const rows = (await db.query.bookings.findMany({
		where: tenantWhere(bookings, tenantId, ...conditions),
		...withRelations,
		orderBy: [asc(bookings.scheduledAt)],
		limit: CALENDAR_ROW_LIMIT,
	})) as BookingRow[];

	const buckets = new Map<string, ReturnType<typeof toItem>[]>();
	for (const key of dayKeysBetween(from, to)) {
		buckets.set(key, []);
	}

	for (const row of rows) {
		const key = utcDayKey(row.scheduledAt);
		const bucket = buckets.get(key);

		if (bucket) {
			bucket.push(toItem(row));
		} else {
			// Oraliq chetidagi kutilmagan kun — yo'qotmaslik uchun o'z guruhini oladi.
			buckets.set(key, [toItem(row)]);
		}
	}

	const days = [...buckets.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([day, items]) => ({ date: day, count: items.length, items }));

	return c.json(
		{
			success: true as const,
			data: {
				view,
				range: { from: from.toISOString(), to: to.toISOString() },
				total: rows.length,
				days,
			},
		},
		200
	);
};

export const getHandler: AppRouteHandler<typeof r.get> = async (c) => {
	const id = c.req.valid("param").id;

	const row = await findWithRelations(currentTenantId(c), id);

	if (!row) {
		throw notFound("Uchrashuv", id);
	}

	await assertCanTouch(c, { id: row.id, assignedTo: row.assignedTo });

	return c.json({ success: true as const, data: toItem(row) }, 200);
};

export const createHandler: AppRouteHandler<typeof r.create> = async (c) => {
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");

	await assertLinkedRecords(tenantId, body);

	const scheduledAt = parseScheduledAt(body.scheduledAt);

	assertNotInPast(scheduledAt);

	const durationMinutes = body.durationMinutes ?? DEFAULT_DURATION_MINUTES;
	const assignedTo = await resolveAssigneeForCreate(c, body.assignedTo);

	await assertSlotIsFree(tenantId, { assignedTo, scheduledAt, durationMinutes });

	const [inserted] = await db
		.insert(bookings)
		.values({
			tenantId,
			contactId: body.contactId,
			callId: body.callId ?? null,
			ticketId: body.ticketId ?? null,
			assignedTo,
			title: body.title,
			notes: body.notes ?? null,
			scheduledAt,
			durationMinutes,
			location: body.location ?? null,
			// API orqali kelgan uchrashuv — odam yaratgan, AI emas.
			createdBySystem: false,
		})
		.returning({ id: bookings.id });

	if (!inserted) {
		throw databaseError("Uchrashuvni yozish natija qaytarmadi");
	}

	const row = await findWithRelations(tenantId, inserted.id);

	if (!row) {
		throw notFound("Uchrashuv", inserted.id);
	}

	await audit(c, {
		action: "bookings.create",
		entityType: "booking",
		entityId: inserted.id,
		details: {
			contactId: row.contactId,
			assignedTo,
			scheduledAt: scheduledAt.toISOString(),
			durationMinutes,
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
		throw notFound("Uchrashuv", id);
	}

	await assertCanTouch(c, { id: existing.id, assignedTo: existing.assignedTo });

	const currentStatus = existing.status as BookingStatus;
	const updates = collectPlainUpdates(body);

	if (body.scheduledAt !== undefined) {
		const scheduledAt = parseScheduledAt(body.scheduledAt);

		assertNotInPast(scheduledAt);
		updates.scheduledAt = scheduledAt;
	}

	const assignee = await resolveAssigneeChange(c, body.assignedTo, existing.assignedTo);

	if (assignee.changed) {
		updates.assignedTo = assignee.value;
	}

	if (body.status !== undefined && body.status !== currentStatus) {
		assertTransition(currentStatus, body.status);
		updates.status = body.status;
	}

	const nextStatus = updates.status ?? currentStatus;
	const timingChanged =
		updates.scheduledAt !== undefined || updates.durationMinutes !== undefined || assignee.changed;
	// Bekor qilingan uchrashuv qayta ochilganda ham joy bo'shligini tekshiramiz.
	const reactivated = currentStatus === "cancelled" && nextStatus !== "cancelled";

	if (nextStatus !== "cancelled" && (timingChanged || reactivated)) {
		await assertSlotIsFree(tenantId, {
			assignedTo: assignee.value,
			scheduledAt: updates.scheduledAt ?? existing.scheduledAt,
			durationMinutes: updates.durationMinutes ?? existing.durationMinutes,
			excludeId: id,
		});
	}

	await db
		.update(bookings)
		.set(updates)
		.where(tenantWhere(bookings, tenantId, eq(bookings.id, id)));

	const updated = await findWithRelations(tenantId, id);

	if (!updated) {
		throw notFound("Uchrashuv", id);
	}

	await audit(c, {
		action: "bookings.update",
		entityType: "booking",
		entityId: id,
		details: {
			fields: Object.keys(updates).filter((field) => field !== "updatedAt"),
			previousStatus: currentStatus,
			status: updated.status,
			previousScheduledAt: existing.scheduledAt.toISOString(),
			scheduledAt: updated.scheduledAt.toISOString(),
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
			id: bookings.id,
			assignedTo: bookings.assignedTo,
			status: bookings.status,
		})
		.from(bookings)
		.where(tenantWhere(bookings, tenantId, eq(bookings.id, id)))
		.limit(1);

	if (!existing) {
		throw notFound("Uchrashuv", id);
	}

	await assertCanTouch(c, { id: existing.id, assignedTo: existing.assignedTo });

	if (existing.status === "cancelled") {
		return c.json({ success: true as const, data: { message: "Allaqachon bekor qilingan" } }, 200);
	}

	// Hard delete yo'q: kalendar tarixi va hisobotlar uchun qator saqlanadi.
	await db
		.update(bookings)
		.set({ status: "cancelled", updatedAt: new Date() })
		.where(tenantWhere(bookings, tenantId, eq(bookings.id, id)));

	await audit(c, {
		action: "bookings.cancel",
		entityType: "booking",
		entityId: id,
		details: { previousStatus: existing.status, status: "cancelled" },
	});

	return c.json({ success: true as const, data: { message: "Bekor qilindi" } }, 200);
};
