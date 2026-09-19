import type { UserRoleType } from "@shared/types";
import { count, eq, ilike } from "drizzle-orm";
import { db } from "@/db";
import { contacts, tickets } from "@/db/schema";
import { audit } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { currentTenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import type { create, get, list, remove, update } from "./tickets.routes";

/** Admin va Supervisor barcha ticketlarni ko'radi/tahrirlaydi; manager faqat o'zini. */
const CAN_SEE_ALL_TICKETS: UserRoleType[] = ["admin", "supervisor"];

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
		creator: {
			columns: {
				id: true,
				phone: true,
				role: true,
			},
		},
	},
};

type TicketRow = {
	id: string;
	contactId: string;
	createdBy: string;
	subject: string;
	description: string;
	category: string | null;
	priority: "low" | "medium" | "high";
	status: "new" | "in_progress" | "resolved" | "closed" | "reopened";
	externalRefId: string | null;
	aiSummary: string | null;
	isDeleted: boolean;
	createdAt: Date;
	updatedAt: Date;
	closedAt: Date | null;
	contact?:
		| {
				id: string;
				phoneNumber: string;
				firstName: string | null;
				lastName: string | null;
		  }
		| {
				id: string;
				phoneNumber: string;
				firstName: string | null;
				lastName: string | null;
		  }[];
	creator?:
		| { id: string; phone: string; role: string }
		| { id: string; phone: string; role: string }[];
};

function toJson(row: TicketRow) {
	const contact = row.contact
		? Array.isArray(row.contact)
			? row.contact[0]
			: row.contact
		: undefined;
	const creator = row.creator
		? Array.isArray(row.creator)
			? row.creator[0]
			: row.creator
		: undefined;
	return {
		id: row.id,
		contactId: row.contactId,
		createdBy: row.createdBy,
		subject: row.subject,
		description: row.description,
		category: row.category,
		priority: row.priority,
		status: row.status,
		externalRefId: row.externalRefId,
		aiSummary: row.aiSummary,
		isDeleted: row.isDeleted,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		closedAt: row.closedAt?.toISOString() ?? null,
		contact: contact
			? {
					id: contact.id,
					phoneNumber: contact.phoneNumber,
					firstName: contact.firstName,
					lastName: contact.lastName,
				}
			: undefined,
		creator: creator ? { id: creator.id, phone: creator.phone, role: creator.role } : undefined,
	};
}

export const listHandler: AppRouteHandler<typeof list> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const { page, limit, status, priority, q, contactId, phoneNumber, createdBy, includeDeleted } =
		c.req.valid("query");
	const offset = (page - 1) * limit;

	const conditions = [];
	if (!CAN_SEE_ALL_TICKETS.includes(user.role)) {
		conditions.push(eq(tickets.createdBy, user.id));
	}
	if (phoneNumber) {
		// A phone number identifies a contact only WITHIN a tenant. Unscoped, this
		// resolves to a neighbour's contact id and the ticket filter below would then
		// be pointed at somebody else's rows.
		const contact = await db.query.contacts.findFirst({
			where: tenantWhere(
				contacts,
				tenantId,
				eq(contacts.phoneNumber, phoneNumber),
				eq(contacts.isDeleted, false)
			),
			columns: { id: true },
		});
		if (contact) {
			conditions.push(eq(tickets.contactId, contact.id));
		} else {
			conditions.push(eq(tickets.contactId, "00000000-0000-0000-0000-000000000000"));
		}
	}
	if (status) {
		conditions.push(eq(tickets.status, status));
	}
	if (priority) {
		conditions.push(eq(tickets.priority, priority));
	}
	if (q) {
		// Foydalanuvchi kiritgan `%` va `_` literal belgi bo'lib qolishi kerak,
		// aks holda qidiruv naqshga aylanib ketadi.
		conditions.push(ilike(tickets.subject, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`));
	}
	if (contactId) {
		conditions.push(eq(tickets.contactId, contactId));
	}
	if (createdBy && CAN_SEE_ALL_TICKETS.includes(user.role)) {
		conditions.push(eq(tickets.createdBy, createdBy));
	}
	if (includeDeleted !== "true") {
		conditions.push(eq(tickets.isDeleted, false));
	}

	// Every client-controlled filter above is optional; the tenant never is, and it
	// leads the AND so the (tenant_id, ...) indexes are the ones used. Repeated at
	// both statements on purpose - a shared `where` hides the tenant from the query
	// that uses it.
	const [items, [totalResult]] = await Promise.all([
		db.query.tickets.findMany({
			where: tenantWhere(tickets, tenantId, ...conditions),
			columns: {
				id: true,
				contactId: true,
				createdBy: true,
				subject: true,
				description: true,
				category: true,
				priority: true,
				status: true,
				externalRefId: true,
				aiSummary: true,
				isDeleted: true,
				createdAt: true,
				updatedAt: true,
				closedAt: true,
			},
			...withRelations,
			orderBy: (t, { desc }) => [desc(t.createdAt)],
			limit,
			offset,
		}),
		db
			.select({ count: count() })
			.from(tickets)
			.where(tenantWhere(tickets, tenantId, ...conditions)),
	]);

	const totalCount = Number(totalResult?.count ?? 0);
	const totalPages = Math.ceil(totalCount / limit);

	return c.json(
		{
			success: true as const,
			data: {
				items: (items as TicketRow[]).map(toJson),
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
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;

	const row = await db.query.tickets.findFirst({
		where: tenantWhere(tickets, tenantId, eq(tickets.id, id)),
		columns: {
			id: true,
			contactId: true,
			createdBy: true,
			subject: true,
			description: true,
			category: true,
			priority: true,
			status: true,
			externalRefId: true,
			aiSummary: true,
			isDeleted: true,
			createdAt: true,
			updatedAt: true,
			closedAt: true,
		},
		...withRelations,
	});

	if (!row) {
		throw notFound("Murojaat", id);
	}

	if (!CAN_SEE_ALL_TICKETS.includes(user.role) && row.createdBy !== user.id) {
		throw notFound("Murojaat", id);
	}

	return c.json({ success: true as const, data: toJson(row as TicketRow) }, 200);
};

export const createHandler: AppRouteHandler<typeof create> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");

	// PARENT OWNERSHIP. contactId arrives in the request body, so this check is the
	// only thing stopping a caller from attaching their ticket to another tenant's
	// contact: the foreign key is satisfied by any contact that exists anywhere. A
	// contact outside this tenant is reported as missing, not as forbidden.
	const [contact] = await db
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

	if (!contact) {
		throw notFound("Kontakt", body.contactId);
	}

	const [inserted] = await db
		.insert(tickets)
		.values({
			tenantId,
			contactId: body.contactId,
			createdBy: user.id,
			subject: body.subject,
			description: body.description,
			category: body.category ?? null,
			priority: body.priority ?? "medium",
		})
		.returning({
			id: tickets.id,
			contactId: tickets.contactId,
			createdBy: tickets.createdBy,
			subject: tickets.subject,
			description: tickets.description,
			category: tickets.category,
			priority: tickets.priority,
			status: tickets.status,
			externalRefId: tickets.externalRefId,
			aiSummary: tickets.aiSummary,
			isDeleted: tickets.isDeleted,
			createdAt: tickets.createdAt,
			updatedAt: tickets.updatedAt,
			closedAt: tickets.closedAt,
		});

	if (!inserted) {
		throw notFound("Murojaat", "insert");
	}

	const row = await db.query.tickets.findFirst({
		where: tenantWhere(tickets, tenantId, eq(tickets.id, inserted.id)),
		columns: {
			id: true,
			contactId: true,
			createdBy: true,
			subject: true,
			description: true,
			category: true,
			priority: true,
			status: true,
			externalRefId: true,
			aiSummary: true,
			isDeleted: true,
			createdAt: true,
			updatedAt: true,
			closedAt: true,
		},
		...withRelations,
	});

	if (!row) {
		throw notFound("Murojaat", inserted.id);
	}

	await audit(c, {
		action: "tickets.create",
		entityType: "ticket",
		entityId: inserted.id,
	});
	return c.json({ success: true as const, data: toJson(row as TicketRow) }, 201);
};

export const updateHandler: AppRouteHandler<typeof update> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;
	const body = c.req.valid("json");

	const row = await db.query.tickets.findFirst({
		where: tenantWhere(tickets, tenantId, eq(tickets.id, id)),
		columns: {
			id: true,
			createdBy: true,
			status: true,
		},
	});

	if (!row) {
		throw notFound("Murojaat", id);
	}

	if (!CAN_SEE_ALL_TICKETS.includes(user.role) && row.createdBy !== user.id) {
		throw notFound("Murojaat", id);
	}

	const updates: {
		subject?: string;
		description?: string;
		category?: string | null;
		priority?: "low" | "medium" | "high";
		status?: "new" | "in_progress" | "resolved" | "closed" | "reopened";
		updatedAt?: Date;
		closedAt?: Date | null;
	} = {
		updatedAt: new Date(),
	};

	if (body.subject !== undefined) {
		updates.subject = body.subject;
	}
	if (body.description !== undefined) {
		updates.description = body.description;
	}
	if (body.category !== undefined) {
		updates.category = body.category;
	}
	if (body.priority !== undefined) {
		updates.priority = body.priority;
	}
	if (body.status !== undefined) {
		updates.status = body.status;
		if (body.status === "closed") {
			updates.closedAt = new Date();
		} else if (row.status === "closed" && body.status !== "closed") {
			updates.closedAt = null;
		}
	}

	await db
		.update(tickets)
		.set(updates)
		.where(tenantWhere(tickets, tenantId, eq(tickets.id, id)));

	const updated = await db.query.tickets.findFirst({
		where: tenantWhere(tickets, tenantId, eq(tickets.id, id)),
		columns: {
			id: true,
			contactId: true,
			createdBy: true,
			subject: true,
			description: true,
			category: true,
			priority: true,
			status: true,
			externalRefId: true,
			aiSummary: true,
			isDeleted: true,
			createdAt: true,
			updatedAt: true,
			closedAt: true,
		},
		...withRelations,
	});

	if (!updated) {
		throw notFound("Murojaat", id);
	}

	await audit(c, {
		action: "tickets.update",
		entityType: "ticket",
		entityId: id,
	});
	return c.json({ success: true as const, data: toJson(updated as TicketRow) }, 200);
};

export const removeHandler: AppRouteHandler<typeof remove> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;

	const row = await db.query.tickets.findFirst({
		where: tenantWhere(tickets, tenantId, eq(tickets.id, id)),
		columns: { id: true, createdBy: true },
	});

	if (!row) {
		throw notFound("Murojaat", id);
	}

	if (!CAN_SEE_ALL_TICKETS.includes(user.role) && row.createdBy !== user.id) {
		throw notFound("Murojaat", id);
	}

	await db
		.update(tickets)
		.set({ isDeleted: true, deletedAt: new Date() })
		.where(tenantWhere(tickets, tenantId, eq(tickets.id, id)));

	await audit(c, {
		action: "tickets.remove",
		entityType: "ticket",
		entityId: id,
	});
	return c.json({ success: true as const, data: { message: "O'chirildi" } }, 200);
};
