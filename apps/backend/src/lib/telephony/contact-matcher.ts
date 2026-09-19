/**
 * Contact matching for the AI voice layer.
 *
 * The phone normalisation here is a verbatim port of the rules the legacy
 * FreePBX webhook already uses (routes/webhooks/freepbx.handlers.ts): digits
 * only, plus the Uzbek 998-prefix pair. It is copied rather than imported
 * because that handler keeps its own private copy and must not be edited - but
 * the RULES are identical on purpose, so a caller matched by the webhook and
 * the same caller matched by the AI agent always resolve to the same contact.
 *
 * What this module adds on top of the webhook is the write side: an inbound AI
 * call must be able to create the contact it is talking to, safely, while a
 * second leg of the same number may be doing exactly the same thing.
 */
import type { TenantId } from "@shared/types";
import { count, desc, eq, inArray, ne } from "drizzle-orm";
import pino from "pino";
import pretty from "pino-pretty";
import { db } from "@/db";
import { calls, contacts, tickets } from "@/db/schema";
import { databaseError } from "@/lib/errors";
import { tenantWhere } from "@/lib/tenancy";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "telephony:contact-matcher",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

/** How many tickets the AI is given as "what this caller contacted us about". */
const DEFAULT_TICKET_HISTORY_LIMIT = 5;

/** Uzbek country code, and the two digit lengths the legacy webhook knows about. */
const UZ_COUNTRY_CODE = "998";
const UZ_NATIONAL_DIGITS = 9;
const UZ_INTERNATIONAL_DIGITS = 12;

/** contacts.address jsonb - the shape the existing CRM UI writes and reads. */
export interface ContactAddress {
	tuman: string;
	kocha: string;
	uy: string;
}

/** A contact as the voice layer needs it. Mirrors the columns, nothing derived. */
export interface ContactMatch {
	id: string;
	phoneNumber: string;
	firstName: string | null;
	lastName: string | null;
	address: ContactAddress | null;
	notes: string | null;
	isDeleted: boolean;
}

export interface ContactHistoryTicket {
	id: string;
	subject: string;
	status: string;
	/** ISO-8601, so it can be dropped straight into a model prompt. */
	createdAt: string;
}

export interface ContactHistory {
	previousCallCount: number;
	/** Newest first. */
	recentTickets: ContactHistoryTicket[];
}

export interface ContactHistoryOptions {
	/**
	 * Exclude one call from the count. The orchestrator inserts the `calls` row
	 * before it builds the AI context, so without this the caller would be told
	 * they have one more previous call than they really do.
	 */
	excludeCallId?: string;
	ticketLimit?: number;
}

const CONTACT_COLUMNS = {
	id: contacts.id,
	phoneNumber: contacts.phoneNumber,
	firstName: contacts.firstName,
	lastName: contacts.lastName,
	address: contacts.address,
	notes: contacts.notes,
	isDeleted: contacts.isDeleted,
};

/**
 * Every stored spelling of a phone number worth looking for.
 *
 * Identical rules to the legacy webhook: strip everything that is not a digit,
 * then add the counterpart of the Uzbek pair - 998901234567 <-> 901234567.
 *
 * The one deliberate difference: an input with no digits at all returns an
 * empty list rather than `[""]`. `[""]` would match a contact whose stored
 * number is literally empty, which is never the right answer for an anonymous
 * or withheld caller id.
 */
export function getPhoneVariations(phone: string): string[] {
	const clean = phone.replace(/\D/g, "");

	if (clean.length === 0) {
		return [];
	}

	const variations = [clean];

	if (clean.startsWith(UZ_COUNTRY_CODE) && clean.length === UZ_INTERNATIONAL_DIGITS) {
		variations.push(clean.slice(UZ_COUNTRY_CODE.length));
	} else if (clean.length === UZ_NATIONAL_DIGITS) {
		variations.push(`${UZ_COUNTRY_CODE}${clean}`);
	}

	return [...new Set(variations)];
}

/**
 * The spelling a NEW contact is stored under: full international digits when we
 * can tell (a bare 9-digit Uzbek mobile becomes 998XXXXXXXXX), otherwise the
 * digits as dialled. Existing rows are never rewritten - lookups already cover
 * both spellings - so this only decides what a freshly created row looks like.
 */
export function canonicalisePhone(phone: string): string {
	const clean = phone.replace(/\D/g, "");

	if (clean.length === UZ_NATIONAL_DIGITS) {
		return `${UZ_COUNTRY_CODE}${clean}`;
	}

	return clean;
}

/**
 * Deterministic winner when several rows match.
 *
 * This can genuinely happen: one row saved as 998901234567 by the CRM UI and
 * another saved as 901234567 by an old import both match the same caller. The
 * legacy webhook used findFirst and took whatever the planner returned, which is
 * not stable. Ranking makes the AI path repeatable: the exact digits dialled
 * win, then the more specific (longer, country-coded) spelling, then the oldest
 * row - the one other CRM records are most likely already attached to.
 */
function compareMatches(a: ContactMatch, b: ContactMatch, variations: string[]): number {
	const rankA = variations.indexOf(a.phoneNumber);
	const rankB = variations.indexOf(b.phoneNumber);
	const safeRankA = rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA;
	const safeRankB = rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB;

	if (safeRankA !== safeRankB) {
		return safeRankA - safeRankB;
	}

	if (a.phoneNumber.length !== b.phoneNumber.length) {
		return b.phoneNumber.length - a.phoneNumber.length;
	}

	return a.id.localeCompare(b.id);
}

function pickBestMatch(rows: ContactMatch[], variations: string[]): ContactMatch | null {
	if (rows.length === 0) {
		return null;
	}

	if (rows.length === 1) {
		return rows[0] ?? null;
	}

	const sorted = [...rows].sort((a, b) => compareMatches(a, b, variations));
	return sorted[0] ?? null;
}

/**
 * Live contacts only - the same `isDeleted = false` filter the legacy webhook
 * and every existing CRM route apply.
 */
export async function findContactByPhone(
	tenantId: TenantId,
	phone: string
): Promise<ContactMatch | null> {
	const variations = getPhoneVariations(phone);

	if (variations.length === 0) {
		return null;
	}

	const rows = await db
		.select(CONTACT_COLUMNS)
		.from(contacts)
		.where(
			tenantWhere(
				contacts,
				tenantId,
				inArray(contacts.phoneNumber, variations),
				eq(contacts.isDeleted, false)
			)
		);

	return pickBestMatch(rows, variations);
}

/**
 * Soft-deleted rows included. Only used on the create path: the unique index
 * `idx_contacts_phone` covers deleted rows too, so an insert can collide with a
 * contact that `findContactByPhone` cannot see.
 */
export async function findAnyContactByPhone(
	tenantId: TenantId,
	phone: string
): Promise<ContactMatch | null> {
	const variations = getPhoneVariations(phone);

	if (variations.length === 0) {
		return null;
	}

	const rows = await db
		.select(CONTACT_COLUMNS)
		.from(contacts)
		.where(tenantWhere(contacts, tenantId, inArray(contacts.phoneNumber, variations)));

	return pickBestMatch(rows, variations);
}

/**
 * True for a Postgres unique-violation (SQLSTATE 23505).
 *
 * Drizzle 0.44+ wraps driver errors in DrizzleQueryError and hangs the original
 * pg error off `cause`, so the chain has to be walked rather than checked once.
 * The message test is the belt-and-braces path for a driver that does not carry
 * a code.
 */
export function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;

	for (let depth = 0; depth < 5 && current; depth += 1) {
		if (typeof current !== "object") {
			break;
		}

		const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };

		if (candidate.code === "23505") {
			return true;
		}

		if (
			typeof candidate.message === "string" &&
			/duplicate key value violates unique constraint/i.test(candidate.message)
		) {
			return true;
		}

		current = candidate.cause;
	}

	return false;
}

/** Bring a soft-deleted contact back: they are on the phone right now. */
async function reviveContact(tenantId: TenantId, match: ContactMatch): Promise<ContactMatch> {
	logger.warn(
		{ contactId: match.id, phoneNumber: match.phoneNumber },
		"soft-deleted contact is calling in, restoring it so the operator can see the record"
	);

	await db
		.update(contacts)
		.set({ isDeleted: false, deletedAt: null, updatedAt: new Date() })
		.where(tenantWhere(contacts, tenantId, eq(contacts.id, match.id)));

	return { ...match, isDeleted: false };
}

async function insertContact(tenantId: TenantId, phone: string): Promise<ContactMatch | null> {
	const [inserted] = await db
		.insert(contacts)
		.values({ tenantId, phoneNumber: canonicalisePhone(phone) })
		.returning(CONTACT_COLUMNS);

	return inserted ?? null;
}

/**
 * The contact for this caller, creating one if we have never spoken.
 *
 * Concurrency: two legs of the same number can arrive milliseconds apart (a
 * redial, or a trunk retry), and both would find nothing and both would insert.
 * `idx_contacts_tenant_phone` is unique, so exactly one insert wins and the other
 * gets SQLSTATE 23505. That is not an error condition here - it is the answer, and
 * it means the row now exists - so the violation is caught and the row is
 * re-selected instead of thrown. Doing it this way rather than with a
 * transaction or an advisory lock keeps the happy path a single INSERT.
 *
 * TENANT. Every lookup here is scoped, which matters more on this path than almost
 * anywhere: an unscoped match on a phone number would attach one customer's caller
 * to another customer's contact record - and then read that contact's name, address
 * and history back to the caller through the agent. The uniqueness rule is
 * per-tenant for the same reason: the same person can be a customer of two call
 * centres, and each must get their own contact row.
 */
export async function findOrCreateContact(
	tenantId: TenantId,
	phone: string
): Promise<{ contact: ContactMatch; created: boolean }> {
	const existing = await findContactByPhone(tenantId, phone);

	if (existing) {
		return { contact: existing, created: false };
	}

	// Nothing visible, but a soft-deleted row would still block the insert.
	const deleted = await findAnyContactByPhone(tenantId, phone);

	if (deleted) {
		return { contact: await reviveContact(tenantId, deleted), created: false };
	}

	try {
		const inserted = await insertContact(tenantId, phone);

		if (inserted) {
			logger.info(
				{ contactId: inserted.id, phoneNumber: inserted.phoneNumber },
				"created a contact for an unknown caller"
			);
			return { contact: inserted, created: true };
		}
	} catch (cause) {
		if (!isUniqueViolation(cause)) {
			logger.error({ err: cause, phone }, "creating a contact for an inbound call failed");
			throw cause;
		}

		logger.debug({ phone }, "concurrent contact insert lost the race, re-selecting");

		const raced = await findAnyContactByPhone(tenantId, phone);

		if (raced) {
			return {
				contact: raced.isDeleted ? await reviveContact(tenantId, raced) : raced,
				created: false,
			};
		}
	}

	// Insert reported success with no row, or the unique violation could not be
	// resolved to a row. Both mean the database is not in the state this call
	// needs, and the caller must not silently continue with a null contact.
	throw databaseError(`Could not resolve a contact for '${phone}'`);
}

/**
 * What we already know about this caller: how often they have phoned before and
 * what they last opened a ticket about. Feeds VoiceSessionContext, which is how
 * the agent can greet a returning caller by name and reference their open case.
 */
export async function getContactHistory(
	tenantId: TenantId,
	contactId: string,
	options: ContactHistoryOptions = {}
): Promise<ContactHistory> {
	const ticketLimit = options.ticketLimit ?? DEFAULT_TICKET_HISTORY_LIMIT;

	// Scoped even though the contact id was resolved inside the tenant: these two
	// reads are the ones the agent SPEAKS. An unscoped ticket subject would be read
	// out loud to the wrong company's caller, which is the worst possible shape for
	// a leak - it never touches a screen anybody audits.
	const [callCountRows, ticketRows] = await Promise.all([
		db
			.select({ value: count() })
			.from(calls)
			.where(
				tenantWhere(
					calls,
					tenantId,
					eq(calls.contactId, contactId),
					options.excludeCallId ? ne(calls.id, options.excludeCallId) : undefined
				)
			),
		db
			.select({
				id: tickets.id,
				subject: tickets.subject,
				status: tickets.status,
				createdAt: tickets.createdAt,
			})
			.from(tickets)
			.where(
				tenantWhere(
					tickets,
					tenantId,
					eq(tickets.contactId, contactId),
					eq(tickets.isDeleted, false)
				)
			)
			.orderBy(desc(tickets.createdAt))
			.limit(ticketLimit),
	]);

	return {
		previousCallCount: Number(callCountRows[0]?.value ?? 0),
		recentTickets: ticketRows.map((row) => ({
			id: row.id,
			subject: row.subject,
			status: row.status,
			createdAt: row.createdAt.toISOString(),
		})),
	};
}
