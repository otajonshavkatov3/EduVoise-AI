import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { calls, contacts, operatorProfiles, tenants } from "@/db/schema";
import { databaseError, notFound } from "@/lib/errors";
import { type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import { broadcastToUser } from "@/lib/ws/registry";

import type { callEnd, callStart } from "./freepbx.routes";

type CallStartBody = {
	direction: "inbound" | "outbound";
	callerNumber: string;
	calleeExtension?: string;
	contactId?: string;
	operatorId?: string;
	ticketId?: string;
};

function getPhoneVariations(phone: string): string[] {
	const clean = phone.replace(/\D/g, "");
	const variations = [clean];

	if (clean.startsWith("998") && clean.length === 12) {
		variations.push(clean.slice(3));
	} else if (clean.length === 9) {
		variations.push("998" + clean);
	}
	// +8 variantlari yoki boshqa holatlarni ham qo'shish mumkin
	return [...new Set(variations)];
}

async function findContactByCallerNumber(tenantId: TenantId, callerNumber: string) {
	const variations = getPhoneVariations(callerNumber);

	// A phone number is a NATURAL KEY, and the same number can be a customer of two
	// call centres. Scoped, so this webhook can only ever attach the call to a contact
	// belonging to the tenant it was resolved for.
	return db.query.contacts.findFirst({
		where: tenantWhere(
			contacts,
			tenantId,
			inArray(contacts.phoneNumber, variations),
			eq(contacts.isDeleted, false)
		),
		columns: { id: true, firstName: true, lastName: true, address: true },
	});
}

async function resolveOperatorProfileId(
	tenantId: TenantId,
	calleeExtension: string | undefined,
	bodyOperatorId: string | undefined
): Promise<string | null> {
	if (calleeExtension) {
		const op = await db.query.operatorProfiles.findFirst({
			where: tenantWhere(
				operatorProfiles,
				tenantId,
				eq(operatorProfiles.extension, calleeExtension),
				eq(operatorProfiles.isDeleted, false)
			),
			columns: { id: true },
		});
		if (op) {
			return op.id;
		}
	}

	// `operatorId` straight out of an UNAUTHENTICATED body, so it is verified rather
	// than trusted: an id belonging to another tenant is dropped, not written.
	if (bodyOperatorId) {
		const owned = await db.query.operatorProfiles.findFirst({
			where: tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.id, bodyOperatorId)),
			columns: { id: true },
		});

		return owned?.id ?? null;
	}

	return null;
}

/**
 * A body-supplied contactId, but only if it is this tenant's.
 *
 * The FK alone would happily accept another customer's contact and file the call
 * against it. This endpoint is unauthenticated, so "the body said so" is the weakest
 * evidence in the system.
 */
async function ownedContactId(
	tenantId: TenantId,
	contactId: string | undefined
): Promise<string | null> {
	if (!contactId) {
		return null;
	}

	const owned = await db.query.contacts.findFirst({
		where: tenantWhere(contacts, tenantId, eq(contacts.id, contactId)),
		columns: { id: true },
	});

	return owned?.id ?? null;
}

async function insertCall(
	tenantId: TenantId,
	body: CallStartBody,
	contactId: string | null,
	operatorProfileId: string | null
) {
	try {
		const [row] = await db
			.insert(calls)
			.values({
				tenantId,
				direction: body.direction,
				callerNumber: body.callerNumber,
				calleeExtension: body.calleeExtension ?? null,
				contactId,
				operatorId: operatorProfileId,
				ticketId: body.ticketId ?? null,
				status: "ringing",
				startedAt: new Date(),
			})
			.returning({
				id: calls.id,
				createdAt: calls.createdAt,
				startedAt: calls.startedAt,
			});

		if (!row) {
			throw databaseError("Yozuvni saqlab bo'lmadi");
		}

		return row;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw databaseError(msg || "Yozuvni saqlab bo'lmadi");
	}
}

async function notifyOperatorIfAny(
	tenantId: TenantId,
	body: CallStartBody,
	row: { id: string; startedAt: Date },
	contact: {
		id: string;
		firstName: string | null;
		lastName: string | null;
		address: unknown;
	} | null
) {
	if (!body.calleeExtension) {
		return;
	}

	// The userId this resolves to is who the "incoming call" push goes to. Unscoped,
	// this webhook would have shown a caller's number and name to whichever customer's
	// operator happened to own the same extension number.
	const op = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			tenantId,
			eq(operatorProfiles.extension, body.calleeExtension),
			eq(operatorProfiles.isDeleted, false)
		),
		columns: { userId: true },
	});

	if (!op) {
		return;
	}

	broadcastToUser(op.userId, {
		type: "incoming_call",
		callId: row.id,
		direction: body.direction,
		callerNumber: body.callerNumber,
		calleeExtension: body.calleeExtension,
		startedAt: row.startedAt.toISOString(),
		contact: contact
			? {
					id: contact.id,
					firstName: contact.firstName ?? null,
					lastName: contact.lastName ?? null,
					contactName: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null,
					address: contact.address ?? null,
				}
			: null,
	});
}

/**
 * The tenant whose PBX is calling, from the secret in its own webhook URL.
 *
 * Before this the handlers resolved "the sole customer" and threw once a second one
 * existed - honest, but it meant the endpoint stopped working the moment the
 * platform had two customers, which is the entire point of the platform. The token
 * is both the identifier and the credential: a PBX has nowhere to put a bearer
 * token, but it can be given a URL.
 *
 * A wrong token is 404, not 401. An unauthenticated endpoint that says "that token
 * is wrong" is an oracle for guessing them, and there is nothing here a stranger is
 * entitled to know exists.
 */
async function tenantFromWebhookToken(token: string): Promise<TenantId> {
	const [row] = await db
		.select({ id: tenants.id, status: tenants.status, isVendor: tenants.isVendor })
		.from(tenants)
		.where(eq(tenants.webhookToken, token))
		.limit(1);

	// The vendor tenant has no PBX of its own, and a suspended or closed customer
	// must not be able to keep booking calls against a balance they no longer have.
	if (row === undefined || row.isVendor || (row.status !== "active" && row.status !== "trial")) {
		throw notFound("Webhook", token.slice(0, 8));
	}

	return row.id;
}

export const callStartHandler: AppRouteHandler<typeof callStart> = async (c) => {
	const tenantId = await tenantFromWebhookToken(c.req.valid("param").webhookToken);
	const body = c.req.valid("json");

	const contact = (await findContactByCallerNumber(tenantId, body.callerNumber)) ?? null;
	const contactId = contact?.id ?? (await ownedContactId(tenantId, body.contactId));
	const operatorProfileId = await resolveOperatorProfileId(
		tenantId,
		body.calleeExtension,
		body.operatorId
	);

	const row = await insertCall(tenantId, body, contactId, operatorProfileId);

	// Professional Call Center: Automatic Busy Status disabled by user request

	await notifyOperatorIfAny(tenantId, body, row, contact);

	return c.json(
		{
			id: row.id,
			success: true as const,
			createdAt: row.createdAt.toISOString(),
			startedAt: row.startedAt.toISOString(),
			contact: contact
				? {
						id: contact.id,
						firstName: contact.firstName ?? null,
						lastName: contact.lastName ?? null,
						contactName: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null,
						address: contact.address ?? null,
					}
				: null,
		},
		200
	);
};

export const callEndHandler: AppRouteHandler<typeof callEnd> = async (c) => {
	// Scoping the UPDATE below by this tenant is what stops one customer's PBX
	// finalising another customer's call by guessing a uuid.
	const tenantId = await tenantFromWebhookToken(c.req.valid("param").webhookToken);
	const body = c.req.valid("json");
	const endedAt = new Date();

	const [updated] = await db
		.update(calls)
		.set({
			duration: body.duration,
			recordingPath: body.recordingPath ?? null,
			status: body.status,
			endedAt,
		})
		.where(tenantWhere(calls, tenantId, eq(calls.id, body.callId)))
		.returning({
			id: calls.id,
			status: calls.status,
			endedAt: calls.endedAt,
			calleeExtension: calls.calleeExtension,
		});

	if (!updated) {
		throw notFound("Qo'ng'iroq", body.callId);
	}

	// Professional Call Center: Notification logic (Auto-status update disabled)
	if (updated.calleeExtension) {
		const opProfile = await db.query.operatorProfiles.findFirst({
			where: tenantWhere(
				operatorProfiles,
				tenantId,
				eq(operatorProfiles.extension, updated.calleeExtension),
				eq(operatorProfiles.isDeleted, false)
			),
			columns: { id: true, userId: true },
		});

		if (opProfile) {
			broadcastToUser(opProfile.userId, {
				type: "call_ended",
				callId: updated.id,
				status: updated.status,
			});
		}
	}

	return c.json(
		{
			success: true as const,
			id: updated.id,
			// body.status, not updated.status: the two are the same value (it was just
			// written), but the column's type also allows "ringing", which this response
			// schema does not. Reading it back off the row is what widened it.
			status: body.status,
			endedAt: updated.endedAt?.toISOString() ?? null,
		},
		200
	);
};
