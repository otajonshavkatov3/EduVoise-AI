// biome-ignore-all lint/style/useNamingConvention: the object keys in this file are wire values - import skip reason codes and `dnc_source` enum labels. They are the strings the API returns and the database stores, so renaming them to camelCase would mean one vocabulary in the code and another on the wire.

/**
 * Lead import, and the do-not-call list.
 *
 * IMPORT REPORTS EVERY ROW, NEVER A COUNT
 *
 * The owner's list arrives as a paste out of a spreadsheet somebody else
 * maintains, so some of it is wrong: a number with a letter in it, the same
 * customer twice, a person who asked last month not to be called. "982 imported,
 * 18 skipped" is useless - the owner has to know WHICH 18 and why, or those rows
 * are silently never called and nobody finds out until the customer complains. So
 * every row comes back with its own status, a machine-readable reason and an Uzbek
 * sentence, the same shape POST /knowledge-base/bulk uses.
 *
 * WHY IT IS FOUR QUERIES AND NOT FOUR THOUSAND
 *
 * The knowledge base imports row by row because each row's insert can fail on its
 * own content. A lead cannot: the only thing that can go wrong is the phone number,
 * and all three checks against the database (already in this campaign, on the
 * do-not-call list, matches an existing contact) are set membership. So the
 * candidate numbers are looked up in three batched queries and the survivors are
 * inserted in one statement per chunk - with ON CONFLICT DO NOTHING, which is what
 * makes a concurrent import of the same file report "already in this campaign"
 * instead of raising.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not create contacts. A lead is somebody we intend to phone; turning every
 * imported row into a CRM contact would fill the contact list with people nobody has
 * spoken to. An existing contact IS linked, so a lead and the person's call history
 * are one click apart and no duplicate contact is created.
 */
import { and, count, desc, eq, ilike, inArray, type SQL } from "drizzle-orm";

import { db } from "@/db";
import type { DncSource, NewCampaignLeadRecord } from "@/db/schema";
import { campaignLeads, contacts, doNotCallList, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import {
	ASKED_ON_CALL_REMOVAL_REFUSAL,
	addToDoNotCall,
	findListedNumbers,
	formatPhone,
	isRemovableSource,
	normalisePhone,
	type ParsedLeadText,
	parseLeadText,
} from "@/lib/campaigns";
import { invalidOperation, notFound } from "@/lib/errors";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import { CAN_DELETE_DNC, CAN_MANAGE, findCampaign } from "./campaigns.handlers";
import type * as r from "./campaigns.routes";
import {
	type DncEntryItem,
	type DncRowResult,
	type ImportRowResult,
	type ImportSkipReason,
	importSkipReasons,
	MAX_IMPORT_ROWS,
} from "./campaigns.schemas";

/** Rows per INSERT. Keeps one statement's parameter count well inside Postgres' limit. */
const INSERT_CHUNK = 200;

/** The Uzbek sentence for each skip reason. One place, so the UI never sees an English code. */
const SKIP_MESSAGES: Record<ImportSkipReason, string> = {
	invalid_number: "Raqam formati noto'g'ri",
	duplicate_in_file: "Bu raqam yuborilgan ro'yxatda takrorlangan",
	already_in_campaign: "Bu raqam shu kampaniyada allaqachon bor",
	do_not_call: "Raqam «qo'ng'iroq qilinmasin» ro'yxatida — import qilinmadi",
	insert_failed: "Baza yozuvni saqlamadi",
};

const DNC_SOURCE_LABELS: Record<DncSource, string> = {
	asked_on_call: "qo'ng'iroqda so'radi",
	manual: "qo'lda kiritilgan",
	import: "import qilingan",
};

// ===========================================
// Import
// ===========================================

/** One row as it arrives, before anything has been checked. */
export interface Candidate {
	index: number;
	/** Line number in the paste, null when structured rows were sent. */
	line: number | null;
	input: string;
	fullName: string | null;
	variables: Record<string, string>;
	note: string | null;
}

/** A candidate whose number is valid, waiting on the set membership checks. */
export interface NormalisedCandidate extends Candidate {
	phoneNumber: string;
}

function skipped(
	candidate: Candidate,
	phoneNumber: string | null,
	reason: ImportSkipReason,
	extra?: string
): ImportRowResult {
	return {
		index: candidate.index,
		line: candidate.line,
		status: reason === "insert_failed" ? "failed" : "skipped",
		input: candidate.input,
		phoneNumber,
		fullName: candidate.fullName,
		leadId: null,
		reason,
		message: extra === undefined ? SKIP_MESSAGES[reason] : `${SKIP_MESSAGES[reason]} (${extra})`,
	};
}

/**
 * Turn the request body into candidates.
 *
 * Two accepted shapes - a pasted textarea and a structured array - because the
 * dashboard offers a paste box and another system may POST rows. Both end up here
 * so the checks below run once.
 */
function toCandidates(body: {
	rows?: { phone: string; fullName?: string; variables?: Record<string, string>; note?: string }[];
	text?: string;
}): { candidates: Candidate[]; parsed: ParsedLeadText | null } {
	if (body.text !== undefined) {
		const parsed = parseLeadText(body.text, MAX_IMPORT_ROWS);

		return {
			parsed,
			candidates: parsed.rows.map((row, index) => ({
				index,
				line: row.line,
				input: row.phone,
				fullName: row.fullName,
				variables: row.variables,
				note: null,
			})),
		};
	}

	return {
		parsed: null,
		candidates: (body.rows ?? []).map((row, index) => ({
			index,
			line: null,
			input: row.phone,
			fullName: row.fullName ?? null,
			variables: row.variables ?? {},
			note: row.note ?? null,
		})),
	};
}

/**
 * Pass one: the two things that need no database at all.
 *
 * A number that is not a number, and the same number twice in one payload. Doing
 * this first is what keeps the batched queries below from having to care about
 * either, and exported so the skip reasons can be tested without a database.
 */
export function screenCandidates(candidates: Candidate[]): {
	accepted: NormalisedCandidate[];
	results: ImportRowResult[];
} {
	const accepted: NormalisedCandidate[] = [];
	const results: ImportRowResult[] = [];
	/** normalised number -> the line (or 1-based position) it was first seen on. */
	const seen = new Map<string, number>();

	for (const candidate of candidates) {
		const normalised = normalisePhone(candidate.input);

		if (!normalised.ok) {
			results.push({
				index: candidate.index,
				line: candidate.line,
				status: "skipped",
				input: candidate.input,
				phoneNumber: null,
				fullName: candidate.fullName,
				leadId: null,
				reason: "invalid_number",
				// The normaliser's own sentence, which also says what a valid number looks like.
				message: normalised.message,
			});
			continue;
		}

		const firstSeenAt = seen.get(normalised.phone);

		if (firstSeenAt !== undefined) {
			results.push(
				skipped(
					candidate,
					normalised.phone,
					"duplicate_in_file",
					`birinchisi: ${firstSeenAt}-qator`
				)
			);
			continue;
		}

		seen.set(normalised.phone, candidate.line ?? candidate.index + 1);
		accepted.push({ ...candidate, phoneNumber: normalised.phone });
	}

	return { accepted, results };
}

interface PendingInsert {
	candidate: NormalisedCandidate;
	values: NewCampaignLeadRecord;
}

/** First and last name into one label, or null when the contact has neither. */
function contactName(row: { firstName: string | null; lastName: string | null }): string | null {
	const joined = [row.firstName, row.lastName]
		.filter((part) => part !== null)
		.join(" ")
		.trim();

	return joined.length > 0 ? joined : null;
}

/**
 * Pass two: the three things only the database knows, in three batched queries.
 *
 * Already in this campaign, on the do-not-call list, and matching a contact -
 * membership questions all, which is why the row count does not change the query
 * count. The do-not-call filter here is a courtesy that shows the owner now; the
 * GUARANTEE is the gate the dialer calls before every originate, so a number added
 * to the list after this import still never gets rung.
 */
async function screenAgainstDatabase(
	tenantId: TenantId,
	campaignId: string,
	accepted: NormalisedCandidate[]
): Promise<{ toInsert: PendingInsert[]; results: ImportRowResult[] }> {
	const phones = accepted.map((candidate) => candidate.phoneNumber);

	if (phones.length === 0) {
		return { toInsert: [], results: [] };
	}

	const [existingRows, listed, contactRows] = await Promise.all([
		db
			.select({ phoneNumber: campaignLeads.phoneNumber })
			.from(campaignLeads)
			.where(
				tenantWhere(
					campaignLeads,
					tenantId,
					eq(campaignLeads.campaignId, campaignId),
					inArray(campaignLeads.phoneNumber, phones)
				)
			),
		findListedNumbers(tenantId, phones),
		// BY PHONE NUMBER, which is a natural key and no longer unique platform-wide:
		// tenancy moved contacts' uniqueness to (tenant_id, phone_number) precisely
		// because two customers can hold the same person. Unscoped, this would match
		// ANOTHER customer's contact row and then write its id and its name onto this
		// lead - a cross-tenant link created by an import, and a stranger's name spoken
		// out loud on the call.
		db
			.select({
				id: contacts.id,
				phoneNumber: contacts.phoneNumber,
				firstName: contacts.firstName,
				lastName: contacts.lastName,
			})
			.from(contacts)
			.where(
				tenantWhere(
					contacts,
					tenantId,
					inArray(contacts.phoneNumber, phones),
					eq(contacts.isDeleted, false)
				)
			),
	]);

	const alreadyInCampaign = new Set(existingRows.map((row) => row.phoneNumber));
	const contactByPhone = new Map(contactRows.map((row) => [row.phoneNumber, row]));
	const toInsert: PendingInsert[] = [];
	const results: ImportRowResult[] = [];

	for (const candidate of accepted) {
		if (alreadyInCampaign.has(candidate.phoneNumber)) {
			results.push(skipped(candidate, candidate.phoneNumber, "already_in_campaign"));
			continue;
		}

		if (listed.has(candidate.phoneNumber)) {
			results.push(skipped(candidate, candidate.phoneNumber, "do_not_call"));
			continue;
		}

		const contact = contactByPhone.get(candidate.phoneNumber);

		toInsert.push({
			candidate,
			values: {
				tenantId,
				campaignId,
				phoneNumber: candidate.phoneNumber,
				// The pasted name wins over the CRM's: the person importing knows who they
				// mean, and a stale contact name would be spoken out loud on the call.
				fullName: candidate.fullName ?? (contact === undefined ? null : contactName(contact)),
				contactId: contact?.id ?? null,
				variables: Object.keys(candidate.variables).length > 0 ? candidate.variables : null,
				note: candidate.note,
			},
		});
	}

	return { toInsert, results };
}

/**
 * Pass three: one INSERT per chunk, tolerant of the concurrent-import race.
 *
 * THE TENANT IS STAMPED HERE, at the statement, over whatever the assembled values
 * carry. Pass two already puts the request's tenant on every row, so today the two
 * agree - but this is the only write in the file, `values` is an object built a
 * hundred lines away, and the last place a row can be given the wrong owner is the
 * INSERT itself. Stamping it here means no future rearrangement of the passes above
 * can smuggle another customer's tenant into this table, which is the one thing the
 * compiler cannot check: tenant_id is NOT NULL, so it insists on A tenant, never on
 * the RIGHT one.
 */
async function insertLeads(
	tenantId: TenantId,
	toInsert: PendingInsert[]
): Promise<ImportRowResult[]> {
	const results: ImportRowResult[] = [];

	for (let offset = 0; offset < toInsert.length; offset += INSERT_CHUNK) {
		const chunk = toInsert.slice(offset, offset + INSERT_CHUNK);
		const inserted = await db
			.insert(campaignLeads)
			.values(chunk.map((row) => ({ ...row.values, tenantId })))
			// The pre-check already removed the known duplicates; this catches a second
			// import of the same file running at the same time, and turns it into a per-row
			// reason rather than a 500.
			.onConflictDoNothing({ target: [campaignLeads.campaignId, campaignLeads.phoneNumber] })
			.returning({ id: campaignLeads.id, phoneNumber: campaignLeads.phoneNumber });

		const idByPhone = new Map(inserted.map((row) => [row.phoneNumber, row.id]));

		for (const row of chunk) {
			const id = idByPhone.get(row.candidate.phoneNumber);

			if (id === undefined) {
				results.push(
					skipped(
						row.candidate,
						row.candidate.phoneNumber,
						"already_in_campaign",
						"parallel import"
					)
				);
				continue;
			}

			results.push({
				index: row.candidate.index,
				line: row.candidate.line,
				status: "created",
				input: row.candidate.input,
				phoneNumber: row.candidate.phoneNumber,
				fullName: row.values.fullName ?? null,
				leadId: id,
				reason: null,
				message: null,
			});
		}
	}

	return results;
}

/** Skip reasons grouped, so the UI can say "14 ta takroriy raqam" without counting itself. */
export function countByReason(results: ImportRowResult[]): Record<ImportSkipReason, number> {
	const counts = {} as Record<ImportSkipReason, number>;

	for (const reason of importSkipReasons) {
		counts[reason] = results.filter((row) => row.reason === reason).length;
	}

	return counts;
}

export const importLeadsHandler: AppRouteHandler<typeof r.importLeads> = async (c) => {
	requireRoles(c, CAN_MANAGE);

	const campaignId = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");
	// The parent, scoped: importing into another tenant's campaign is a 404, so no row
	// can be written into a queue that is not the caller's.
	const campaign = await findCampaign(tenantId, campaignId);

	// Importing into a campaign that is over would add rows nothing will ever dial.
	if (campaign.status === "finished" || campaign.status === "cancelled") {
		throw invalidOperation(
			"Tugagan yoki bekor qilingan kampaniyaga raqam qo'shib bo'lmaydi — yangi kampaniya yarating."
		);
	}

	const { candidates, parsed } = toCandidates(body);
	const firstPass = screenCandidates(candidates);
	const secondPass = await screenAgainstDatabase(tenantId, campaignId, firstPass.accepted);
	const thirdPass = await insertLeads(tenantId, secondPass.toInsert);

	// Report in the order the rows were submitted, not in the order they were checked.
	const results = [...firstPass.results, ...secondPass.results, ...thirdPass].sort(
		(left, right) => left.index - right.index
	);

	const created = results.filter((row) => row.status === "created").length;
	const skippedCount = results.filter((row) => row.status === "skipped").length;
	const failed = results.filter((row) => row.status === "failed").length;
	const skippedByReason = countByReason(results);

	await audit(c, {
		action: "campaign.leads.import",
		entityType: "call_campaign",
		entityId: campaignId,
		details: {
			submitted: candidates.length,
			created,
			skipped: skippedCount,
			failed,
			skippedByReason,
			source: body.text === undefined ? "rows" : "text",
			headers: parsed?.headers ?? null,
		},
	});

	const payload = {
		success: true as const,
		data: {
			campaignId,
			submitted: candidates.length,
			created,
			skipped: skippedCount,
			failed,
			skippedByReason,
			parsed:
				parsed === null
					? null
					: {
							delimiter: parsed.delimiter,
							headers: parsed.headers,
							ignoredLines: parsed.ignoredLines,
							truncated: parsed.truncated,
						},
			results,
		},
	};

	return created > 0 ? c.json(payload, 201) : c.json(payload, 200);
};

// ===========================================
// Do-not-call list
// ===========================================

function toDncItem(row: {
	id: string;
	phoneNumber: string;
	reason: string | null;
	source: DncSource;
	callId: string | null;
	createdBy: string | null;
	createdByUsername: string | null;
	createdByPhone: string | null;
	createdAt: Date;
}): DncEntryItem {
	return {
		id: row.id,
		phoneNumber: row.phoneNumber,
		phoneDisplay: formatPhone(row.phoneNumber),
		reason: row.reason,
		source: row.source,
		sourceLabel: DNC_SOURCE_LABELS[row.source],
		callId: row.callId,
		createdBy: row.createdBy,
		createdByName:
			row.createdByPhone === null ? null : (row.createdByUsername ?? row.createdByPhone),
		removable: isRemovableSource(row.source),
		createdAt: row.createdAt.toISOString(),
	};
}

export const listDncHandler: AppRouteHandler<typeof r.listDnc> = async (c) => {
	const query = c.req.valid("query");
	const tenantId = currentTenantId(c);
	const offset = (query.page - 1) * query.limit;

	// Source and the digit search go on top of the tenant, never instead of it: this
	// list is the numbers of people who refused THIS customer, and one customer's
	// refusals also reveal which numbers the other customer holds.
	const conditions: SQL[] = [];

	if (query.source !== undefined) {
		conditions.push(eq(doNotCallList.source, query.source));
	}

	if (query.q !== undefined) {
		// Digits only: a search for "+998 90" has to find 998905706507.
		const digits = query.q.replace(/\D/g, "");

		conditions.push(
			ilike(
				doNotCallList.phoneNumber,
				`%${(digits.length > 0 ? digits : query.q).replace(/[\\%_]/g, "\\$&")}%`
			)
		);
	}

	// Shared so the page and the total ask the same question; the tenant is written at
	// each statement so neither can lose it.
	const filters = conditions.length > 0 ? and(...conditions) : undefined;

	const [rows, countRows] = await Promise.all([
		db
			.select({
				id: doNotCallList.id,
				phoneNumber: doNotCallList.phoneNumber,
				reason: doNotCallList.reason,
				source: doNotCallList.source,
				callId: doNotCallList.callId,
				createdBy: doNotCallList.createdBy,
				createdByUsername: users.username,
				createdByPhone: users.phone,
				createdAt: doNotCallList.createdAt,
			})
			.from(doNotCallList)
			// The joined side is scoped too: without it, an entry created by a vendor
			// account (or by any row whose created_by ever pointed outside this tenant)
			// would render that person's name and login phone in a customer's own list.
			.leftJoin(users, and(eq(doNotCallList.createdBy, users.id), eq(users.tenantId, tenantId)))
			.where(tenantWhere(doNotCallList, tenantId, filters))
			.orderBy(desc(doNotCallList.createdAt))
			.limit(query.limit)
			.offset(offset),
		db
			.select({ value: count() })
			.from(doNotCallList)
			.where(tenantWhere(doNotCallList, tenantId, filters)),
	]);

	const total = Number(countRows[0]?.value ?? 0);

	return c.json(
		{
			success: true as const,
			data: {
				items: rows.map(toDncItem),
				meta: {
					total,
					page: query.page,
					limit: query.limit,
					totalPages: Math.ceil(total / query.limit),
				},
			},
		},
		200
	);
};

export const createDncHandler: AppRouteHandler<typeof r.createDnc> = async (c) => {
	requireRoles(c, CAN_MANAGE);

	const user = c.get("user");
	const body = c.req.valid("json");
	// A single number typed into a box is `manual`; a pasted list is an `import`. The
	// distinction matters because it is the only thing that says how much a reason of
	// "" is worth.
	const source: DncSource = body.source ?? (body.phones.length > 1 ? "import" : "manual");

	const results: DncRowResult[] = [];
	let leadsSkipped = 0;

	// Sequential: each add also pulls the number out of every campaign queue, which is
	// an UPDATE, and a list this size is an administrative action rather than a hot path.
	for (const [index, raw] of body.phones.entries()) {
		const normalised = normalisePhone(raw);

		if (!normalised.ok) {
			results.push({
				index,
				input: raw,
				phoneNumber: null,
				status: "failed",
				message: normalised.message,
				leadsSkipped: 0,
			});
			continue;
		}

		const added = await addToDoNotCall({
			tenantId: currentTenantId(c),
			phoneNumber: normalised.phone,
			reason: body.reason ?? null,
			source,
			createdBy: user.id,
		});

		if (added === null) {
			results.push({
				index,
				input: raw,
				phoneNumber: normalised.phone,
				status: "failed",
				message: "Yozuv saqlanmadi — qaytadan urinib ko'ring",
				leadsSkipped: 0,
			});
			continue;
		}

		leadsSkipped += added.leadsSkipped;
		results.push({
			index,
			input: raw,
			phoneNumber: normalised.phone,
			status: added.created ? "created" : "existing",
			message: added.created
				? null
				: `Raqam ro'yxatda allaqachon bor (${DNC_SOURCE_LABELS[added.entry.source]})`,
			leadsSkipped: added.leadsSkipped,
		});
	}

	const created = results.filter((row) => row.status === "created").length;
	const existing = results.filter((row) => row.status === "existing").length;
	const failed = results.filter((row) => row.status === "failed").length;

	await audit(c, {
		action: "campaign.dnc.add",
		entityType: "do_not_call_list",
		entityId: null,
		details: {
			submitted: body.phones.length,
			created,
			existing,
			failed,
			source,
			leadsSkipped,
			// The numbers themselves, so the audit row explains a customer who stopped
			// being called. Bounded, because this endpoint accepts a thousand.
			phones: results
				.slice(0, 50)
				.map((row) => row.phoneNumber)
				.filter((phone): phone is string => phone !== null),
		},
	});

	const payload = {
		success: true as const,
		data: { created, existing, failed, leadsSkipped, results },
	};

	return created > 0 ? c.json(payload, 201) : c.json(payload, 200);
};

export const removeDncHandler: AppRouteHandler<typeof r.removeDnc> = async (c) => {
	requireRoles(c, CAN_DELETE_DNC);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const entry = await db.query.doNotCallList.findFirst({
		where: tenantWhere(doNotCallList, tenantId, eq(doNotCallList.id, id)),
	});

	if (entry === undefined) {
		throw notFound("«Qo'ng'iroq qilinmasin» yozuvi", id);
	}

	// A spoken refusal is not an administrative record somebody may tidy up. See
	// isRemovableSource in lib/campaigns/do-not-call.ts.
	if (!isRemovableSource(entry.source)) {
		throw invalidOperation(ASKED_ON_CALL_REMOVAL_REFUSAL);
	}

	await db
		.delete(doNotCallList)
		.where(tenantWhere(doNotCallList, tenantId, eq(doNotCallList.id, id)));

	await audit(c, {
		action: "campaign.dnc.remove",
		entityType: "do_not_call_list",
		entityId: id,
		details: {
			phoneNumber: entry.phoneNumber,
			source: entry.source,
			reason: entry.reason,
			addedAt: entry.createdAt.toISOString(),
		},
	});

	return c.json(
		{
			success: true as const,
			data: {
				message: `${formatPhone(entry.phoneNumber)} ro'yxatdan chiqarildi — bu raqamga yana qo'ng'iroq qilinishi mumkin`,
			},
		},
		200
	);
};
