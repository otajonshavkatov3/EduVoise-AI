/**
 * The do-not-call list, and the one gate every outbound dial has to pass through.
 *
 * This is the most important guardrail in the whole feature. A system that cannot
 * take no for an answer is not a professional dialer, it is a liability: the person
 * who said "don't call me again" will say it once, to a machine, and if that
 * sentence does not survive the end of the call then every later campaign re-dials
 * them and the business is the one that looks dishonest.
 *
 * So there is exactly one function - `checkDialAllowed` - and every path that
 * places an outbound call calls it immediately before originating, not at import
 * time and not at campaign start. Import-time filtering is a convenience that
 * tells the owner early; it is not the guarantee. The guarantee is that a number
 * added to this list at 14:31 is refused at 14:32 even though the campaign was
 * imported last week and is already running.
 *
 * `addToDoNotCall` is idempotent because the AI may write it more than once in one
 * conversation (a person who is annoyed says it twice), and because the first
 * reason recorded - the one the person actually gave - is the one worth keeping.
 */
import type { TenantId } from "@shared/types";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import type { DncSource, DoNotCallRecord } from "@/db/schema";
import { campaignLeads, doNotCallList } from "@/db/schema";
import { tenantWhere } from "@/lib/tenancy";

import { normalisePhone, type PhoneKind } from "./phone";

/** Chunk size for the batch membership query, so a 1000-row import stays one round trip per chunk. */
const LOOKUP_CHUNK = 500;

export interface DialAllowed {
	allowed: true;
	/** The normalised, stored form - use THIS to build the dial string. */
	phone: string;
	kind: PhoneKind;
}

export interface DialBlocked {
	allowed: false;
	reason: "invalid_number" | "do_not_call";
	/** Uzbek, safe to show and safe to log. */
	message: string;
	/** The normalised form when the number itself was fine, null when it was not. */
	phone: string | null;
}

export type DialGate = DialAllowed | DialBlocked;

export interface AddToDoNotCallInput {
	/**
	 * Whose list. One customer's caller asking not to be rung again says nothing
	 * about another customer, and a shared list would also tell customer B that
	 * customer A holds that number.
	 */
	tenantId: TenantId;
	/** Raw or normalised; it is normalised here so a caller cannot bypass the form. */
	phoneNumber: string;
	reason?: string | null;
	source: DncSource;
	/** The call the person asked on, for `asked_on_call`. */
	callId?: string | null;
	/** The user who added it by hand. Null when the AI wrote it. */
	createdBy?: string | null;
}

export interface AddToDoNotCallResult {
	/** false — the number was already on the list, and the existing row was kept. */
	created: boolean;
	entry: DoNotCallRecord;
	/**
	 * How many still-queued campaign leads were taken out of the queue as a result.
	 * Pending rows only: a lead already on a live call is finished by the call path,
	 * and a lead that is done keeps the outcome it earned.
	 */
	leadsSkipped: number;
}

/**
 * THE gate. Call this immediately before every originate.
 *
 * Two refusals, both of which have to happen before a channel exists: a number
 * nobody can dial, and a person who asked not to be dialled.
 */
export async function checkDialAllowed(tenantId: TenantId, rawPhone: string): Promise<DialGate> {
	const normalised = normalisePhone(rawPhone);

	if (!normalised.ok) {
		return {
			allowed: false,
			reason: "invalid_number",
			message: normalised.message,
			phone: null,
		};
	}

	if (await isDoNotCall(tenantId, normalised.phone)) {
		return {
			allowed: false,
			reason: "do_not_call",
			message: "Bu raqam «qo'ng'iroq qilinmasin» ro'yxatida — unga qo'ng'iroq qilinmaydi.",
			phone: normalised.phone,
		};
	}

	return { allowed: true, phone: normalised.phone, kind: normalised.kind };
}

/** Membership for one already-normalised number. */
export async function isDoNotCall(tenantId: TenantId, storedPhone: string): Promise<boolean> {
	const [row] = await db
		.select({ id: doNotCallList.id })
		.from(doNotCallList)
		.where(tenantWhere(doNotCallList, tenantId, eq(doNotCallList.phoneNumber, storedPhone)))
		.limit(1);

	return row !== undefined;
}

/**
 * Membership for many numbers at once, as the subset that IS listed.
 *
 * The import path needs this: checking a thousand rows one at a time would be a
 * thousand round trips, and the per-row skip reason is the same either way.
 */
export async function findListedNumbers(
	tenantId: TenantId,
	storedPhones: string[]
): Promise<Set<string>> {
	const listed = new Set<string>();
	const unique = Array.from(new Set(storedPhones));

	for (let offset = 0; offset < unique.length; offset += LOOKUP_CHUNK) {
		const chunk = unique.slice(offset, offset + LOOKUP_CHUNK);

		if (chunk.length === 0) {
			continue;
		}

		const rows = await db
			.select({ phoneNumber: doNotCallList.phoneNumber })
			.from(doNotCallList)
			.where(tenantWhere(doNotCallList, tenantId, inArray(doNotCallList.phoneNumber, chunk)));

		for (const row of rows) {
			listed.add(row.phoneNumber);
		}
	}

	return listed;
}

/**
 * Add a number, idempotently, and pull it out of every queue it is still sitting in.
 *
 * Throws only on a genuinely unusable number - a caller with a raw string has to
 * handle that case anyway, and silently dropping the request would mean a person
 * who asked to be removed was not.
 */
export async function addToDoNotCall(
	input: AddToDoNotCallInput
): Promise<AddToDoNotCallResult | null> {
	const normalised = normalisePhone(input.phoneNumber);

	if (!normalised.ok) {
		return null;
	}

	const phone = normalised.phone;

	// ON CONFLICT DO NOTHING rather than an upsert: re-adding must not overwrite the
	// reason the person gave the first time, and must not move `created_at` - "since
	// when" is part of the record.
	const [inserted] = await db
		.insert(doNotCallList)
		.values({
			tenantId: input.tenantId,
			phoneNumber: phone,
			reason: input.reason ?? null,
			source: input.source,
			callId: input.callId ?? null,
			createdBy: input.createdBy ?? null,
		})
		.onConflictDoNothing({ target: [doNotCallList.tenantId, doNotCallList.phoneNumber] })
		.returning();

	const entry =
		inserted ??
		(await db.query.doNotCallList.findFirst({
			where: tenantWhere(doNotCallList, input.tenantId, eq(doNotCallList.phoneNumber, phone)),
		}));

	if (entry === undefined) {
		// Only reachable if the row vanished between the insert and the read, which
		// means somebody deleted it concurrently. Reporting null is honest; the caller
		// treats it as "not recorded" and can retry.
		return null;
	}

	// Take the number out of every queue it is still in. Pending rows only - see the
	// field comment on leadsSkipped.
	const skipped = await db
		.update(campaignLeads)
		.set({
			status: "skipped",
			outcome: "do_not_call",
			nextAttemptAt: null,
			note: "«Qo'ng'iroq qilinmasin» ro'yxatiga qo'shilgani uchun navbatdan chiqarildi",
			updatedAt: new Date(),
		})
		.where(
			tenantWhere(
				campaignLeads,
				input.tenantId,
				eq(campaignLeads.phoneNumber, phone),
				eq(campaignLeads.status, "pending")
			)
		)
		.returning({ id: campaignLeads.id });

	return { created: inserted !== undefined, entry, leadsSkipped: skipped.length };
}

/**
 * May an entry be taken off the list?
 *
 * Never for `asked_on_call`. A person's spoken refusal is not an administrative
 * record somebody may tidy up later, and making it deletable would turn the whole
 * guardrail into a suggestion. A hand-typed or imported entry, on the other hand,
 * can simply be a typo that blocks the wrong customer, so those are removable - by
 * an admin, with an audit row.
 */
export function isRemovableSource(source: DncSource): boolean {
	return source !== "asked_on_call";
}

/** Why a removal was refused, in Uzbek. */
export const ASKED_ON_CALL_REMOVAL_REFUSAL =
	"Bu raqamni odamning o'zi qo'ng'iroq vaqtida so'rab kiritgan — bunday yozuv o'chirilmaydi. " +
	"Qo'lda yoki import bilan kiritilgan yozuvlarni o'chirish mumkin.";
