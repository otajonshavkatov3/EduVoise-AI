import type { TenantId, UserRoleType } from "@shared/types";
import { count, eq, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { calls, contacts, tickets } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import { alreadyExists, notFound } from "@/lib/errors";
import { currentTenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import type { create, get, list, lookup, remove, update } from "./contacts.routes";

const ALLOWED_DELETE_ROLES: UserRoleType[] = ["admin", "supervisor"];

type Address = { tuman: string; kocha: string; uy: string } | null;

type Row = {
	id: string;
	phoneNumber: string;
	firstName: string | null;
	lastName: string | null;
	address: Address;
	notes: string | null;
	isDeleted: boolean;
	createdAt: Date;
	updatedAt: Date;
};

function toJson(r: Row) {
	return {
		id: r.id,
		phoneNumber: r.phoneNumber,
		firstName: r.firstName,
		lastName: r.lastName,
		address: r.address,
		notes: r.notes,
		isDeleted: r.isDeleted,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	};
}

/**
 * `ContactItemSchema` `callsCount` va `ticketsCount` ni talab qiladi, shuning
 * uchun har bir bitta-kontakt javobi ularni haqiqiy hisobdan olishi kerak.
 * Nol qiymat faqat rostdan ham yozuv bo'lmaganda chiqadi — o'rin to'ldirish
 * uchun emas.
 *
 * The call count is looked up by PHONE NUMBER - a natural key, not an id - and a
 * phone number is not unique across the platform: the same person can be a
 * customer of two call centres. Without the tenant filter this number would count
 * another tenant's calls, so the tenant is a required argument rather than an
 * optional one.
 */
async function contactCounts(tenantId: TenantId, contactId: string, phoneNumber: string) {
	const [callsCountResult, ticketsCountResult] = await Promise.all([
		db
			.select({ count: count() })
			.from(calls)
			.where(tenantWhere(calls, tenantId, eq(calls.callerNumber, phoneNumber))),
		db
			.select({ count: count() })
			.from(tickets)
			.where(
				tenantWhere(
					tickets,
					tenantId,
					eq(tickets.contactId, contactId),
					eq(tickets.isDeleted, false)
				)
			),
	]);

	return {
		callsCount: Number(callsCountResult[0]?.count ?? 0),
		ticketsCount: Number(ticketsCountResult[0]?.count ?? 0),
	};
}

export const listHandler: AppRouteHandler<typeof list> = async (c) => {
	const tenantId = currentTenantId(c);
	const { page, limit, includeDeleted, phoneNumber, q } = c.req.valid("query");
	const offset = (page - 1) * limit;

	const conditions = [];
	if (includeDeleted !== "true") {
		conditions.push(eq(contacts.isDeleted, false));
	}
	if (phoneNumber) {
		conditions.push(eq(contacts.phoneNumber, phoneNumber));
	}
	if (q) {
		const like = `%${q}%`;
		conditions.push(
			or(
				ilike(contacts.phoneNumber, like),
				ilike(contacts.firstName, like),
				ilike(contacts.lastName, like)
			)
		);
	}

	// The tenant is not one filter among several: it is the leading term of every
	// index and the only condition that is never optional. A filter, a sort or a
	// page cursor the client controls can change the rest - none of them can widen
	// this.
	//
	// Written out at BOTH statements rather than shared in a `where` variable: the
	// page and its total are two queries, and a tenant filter that lives one line
	// above them can be edited away without either query looking wrong. `conditions`
	// stays shared, so the page and the count still ask the same question.
	const [items, [total]] = await Promise.all([
		db.query.contacts.findMany({
			where: tenantWhere(contacts, tenantId, ...conditions),
			columns: {
				id: true,
				phoneNumber: true,
				firstName: true,
				lastName: true,
				address: true,
				notes: true,
				isDeleted: true,
				createdAt: true,
				updatedAt: true,
			},
			orderBy: (t, { desc }) => [desc(t.createdAt)],
			limit,
			offset,
		}),
		db
			.select({ count: count() })
			.from(contacts)
			.where(tenantWhere(contacts, tenantId, ...conditions)),
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

export const getHandler: AppRouteHandler<typeof get> = async (c) => {
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;
	// Another tenant's id answers 404, not 403: "you may not see this" would confirm
	// the row exists somewhere, and that is itself information.
	const row = await db.query.contacts.findFirst({
		where: tenantWhere(contacts, tenantId, eq(contacts.id, id)),
		columns: {
			id: true,
			phoneNumber: true,
			firstName: true,
			lastName: true,
			address: true,
			notes: true,
			isDeleted: true,
			createdAt: true,
			updatedAt: true,
		},
	});

	if (!row) {
		throw notFound("Kontakt", id);
	}

	const counts = await contactCounts(tenantId, id, row.phoneNumber);

	return c.json(
		{
			success: true as const,
			data: {
				...toJson(row as Row),
				...counts,
			},
		},
		200
	);
};

export const createHandler: AppRouteHandler<typeof create> = async (c) => {
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");

	// The uniqueness rule is now (tenant_id, phone_number), so this duplicate check
	// must be scoped the same way. Unscoped it would refuse a number another
	// customer already has - both a false conflict and a disclosure that the number
	// exists elsewhere.
	const existing = await db.query.contacts.findFirst({
		where: tenantWhere(contacts, tenantId, eq(contacts.phoneNumber, body.phoneNumber)),
	});

	// Agar soft delete qilingan bo'lsa — qayta tiklaymiz
	if (existing?.isDeleted) {
		await db
			.update(contacts)
			.set({
				firstName: body.firstName ?? null,
				lastName: body.lastName ?? null,
				address: body.address ?? null,
				notes: body.notes ?? null,
				isDeleted: false,
				deletedAt: null,
				updatedAt: new Date(),
			})
			.where(tenantWhere(contacts, tenantId, eq(contacts.id, existing.id)));

		const row = await db.query.contacts.findFirst({
			where: tenantWhere(contacts, tenantId, eq(contacts.id, existing.id)),
			columns: {
				id: true,
				phoneNumber: true,
				firstName: true,
				lastName: true,
				address: true,
				notes: true,
				isDeleted: true,
				createdAt: true,
				updatedAt: true,
			},
		});
		if (!row) {
			throw notFound("Kontakt", existing.id);
		}
		await audit(c, {
			action: "contacts.create",
			entityType: "contact",
			entityId: existing.id,
			details: { restored: true },
		});
		const restoredCounts = await contactCounts(tenantId, existing.id, row.phoneNumber);
		return c.json(
			{ success: true as const, data: { ...toJson(row as Row), ...restoredCounts } },
			201
		);
	}

	if (existing && !existing.isDeleted) {
		throw alreadyExists("Kontakt", "telefon raqami");
	}

	const [inserted] = await db
		.insert(contacts)
		.values({
			tenantId,
			phoneNumber: body.phoneNumber,
			firstName: body.firstName ?? null,
			lastName: body.lastName ?? null,
			address: body.address ?? null,
			notes: body.notes ?? null,
		})
		.returning({
			id: contacts.id,
			phoneNumber: contacts.phoneNumber,
			firstName: contacts.firstName,
			lastName: contacts.lastName,
			address: contacts.address,
			notes: contacts.notes,
			isDeleted: contacts.isDeleted,
			createdAt: contacts.createdAt,
			updatedAt: contacts.updatedAt,
		});

	if (!inserted) {
		throw notFound("Kontakt", "insert");
	}

	await audit(c, {
		action: "contacts.create",
		entityType: "contact",
		entityId: inserted.id,
	});
	const createdCounts = await contactCounts(tenantId, inserted.id, inserted.phoneNumber);
	return c.json(
		{ success: true as const, data: { ...toJson(inserted as Row), ...createdCounts } },
		201
	);
};

export const updateHandler: AppRouteHandler<typeof update> = async (c) => {
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;
	const body = c.req.valid("json");

	const existing = await db.query.contacts.findFirst({
		where: tenantWhere(contacts, tenantId, eq(contacts.id, id)),
	});

	if (!existing) {
		throw notFound("Kontakt", id);
	}

	if (body.phoneNumber !== undefined && body.phoneNumber !== existing.phoneNumber) {
		const other = await db.query.contacts.findFirst({
			where: tenantWhere(contacts, tenantId, eq(contacts.phoneNumber, body.phoneNumber)),
		});
		if (other && !other.isDeleted) {
			throw alreadyExists("Kontakt", "telefon raqami");
		}
	}

	await db
		.update(contacts)
		.set({
			phoneNumber: body.phoneNumber ?? existing.phoneNumber,
			firstName: body.firstName ?? existing.firstName,
			lastName: body.lastName ?? existing.lastName,
			address: body.address !== undefined ? body.address : (existing.address as Address),
			notes: body.notes !== undefined ? body.notes : existing.notes,
			updatedAt: new Date(),
		})
		.where(tenantWhere(contacts, tenantId, eq(contacts.id, id)));

	const row = await db.query.contacts.findFirst({
		where: tenantWhere(contacts, tenantId, eq(contacts.id, id)),
		columns: {
			id: true,
			phoneNumber: true,
			firstName: true,
			lastName: true,
			address: true,
			notes: true,
			isDeleted: true,
			createdAt: true,
			updatedAt: true,
		},
	});
	if (!row) {
		throw notFound("Kontakt", id);
	}

	await audit(c, { action: "contacts.update", entityType: "contact", entityId: id });
	const updatedCounts = await contactCounts(tenantId, id, row.phoneNumber);
	return c.json({ success: true as const, data: { ...toJson(row as Row), ...updatedCounts } }, 200);
};

export const removeHandler: AppRouteHandler<typeof remove> = async (c) => {
	requireRoles(c, ALLOWED_DELETE_ROLES);
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;

	const [r] = await db
		.update(contacts)
		.set({ isDeleted: true, deletedAt: new Date(), updatedAt: new Date() })
		.where(tenantWhere(contacts, tenantId, eq(contacts.id, id)))
		.returning({ id: contacts.id });

	if (!r) {
		throw notFound("Kontakt", id);
	}

	await audit(c, { action: "contacts.remove", entityType: "contact", entityId: id });
	return c.json({ success: true as const, data: { message: "O'chirildi" } }, 200);
};

// Caller ID Auto-Lookup API: indexed search by phone number.
// A phone number is a NATURAL KEY and is unique only per tenant, so this lookup is
// the one most likely to hand back a neighbour's customer record if it is left
// unscoped - it answers with a name and an address for any number the caller can type.
export const lookupHandler: AppRouteHandler<typeof lookup> = async (c) => {
	const tenantId = currentTenantId(c);
	const { phoneNumber } = c.req.valid("query");

	const row = await db.query.contacts.findFirst({
		where: tenantWhere(
			contacts,
			tenantId,
			eq(contacts.phoneNumber, phoneNumber),
			eq(contacts.isDeleted, false)
		),
		columns: {
			id: true,
			phoneNumber: true,
			firstName: true,
			lastName: true,
			address: true,
			notes: true,
			isDeleted: true,
			createdAt: true,
			updatedAt: true,
		},
	});

	return c.json(
		{
			success: true as const,
			data: {
				contact: row ? toJson(row as Row) : null,
			},
		},
		200
	);
};
