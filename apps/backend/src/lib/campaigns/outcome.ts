/**
 * The one writer that records what a call produced.
 *
 * Three tables have to move together when a dial ends - the lead's dial state, the
 * attempt history, and (when the person asked) the do-not-call list - and a second
 * copy of this logic anywhere would eventually move two of the three. So the call
 * path and the campaign API both come through here:
 *
 *   the dialer      countAttempt: true   - a real dial, so attempts++ and an
 *                                          attempt row is written
 *   the campaign UI countAttempt: false  - a supervisor recording what happened
 *                                          when they phoned somebody back by hand
 *
 * The campaign is finished here too, not by a separate sweep: the moment the last
 * lead leaves the queue, the campaign that was running has nothing left to do, and
 * discovering that on the next tick instead would leave a "running" campaign that
 * never dials sitting on the page.
 */
import type { TenantId } from "@shared/types";
import { count, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import type { CampaignLeadRecord, CampaignOutcome } from "@/db/schema";
import { callCampaigns, campaignCallAttempts, campaignLeads } from "@/db/schema";
import { notFound } from "@/lib/errors";
import { tenantWhere } from "@/lib/tenancy";

import { addToDoNotCall } from "./do-not-call";
import { retryPlan } from "./retry";

export interface RecordDialOutcomeInput {
	leadId: string;
	outcome: CampaignOutcome;
	/** The call this outcome came from. Null for a hand-recorded outcome. */
	callId?: string | null;
	/** Why it ended this way - kept on the attempt row, not on the lead. */
	detail?: string | null;
	/** A note for the lead. Replaces whatever was there; null leaves it alone. */
	note?: string | null;
	/** true - this was a real dial. false - a human is recording it after the fact. */
	countAttempt: boolean;
	/**
	 * WHERE THE TENANT COMES FROM, and why this is optional.
	 *
	 * Pass it whenever the caller has a request: the lead lookup is then scoped to
	 * it, so a leadId belonging to another customer is a 404 here rather than an
	 * outcome written onto their queue. routes/campaigns does exactly that.
	 *
	 * The dialer's outcome hook cannot: it is handed an OutboundOutcomeEvent by the
	 * telephony layer, which carries a callId and a leadId and no tenant (see
	 * lib/telephony/outbound.ts - adding one there is the seam that would make this
	 * required). So when it is absent the tenant is taken from the LEAD ROW, and
	 * every statement after the lookup uses `lead.tenantId` rather than a guess:
	 * the campaign read, the lead update, the attempt insert and the
	 * finish-the-campaign check are all scoped to the tenant that owns the row the
	 * outcome is about. Nothing here defaults to a tenant, and nothing reads a
	 * tenant out of a caller-supplied field other than this one.
	 */
	tenantId?: TenantId;
	/** Set when a person asked to be removed, so the DNC row records who heard it. */
	recordedBy?: string | null;
	now?: Date;
}

export interface RecordDialOutcomeResult {
	lead: CampaignLeadRecord;
	/** The attempt row written, or null when countAttempt was false. */
	attemptId: string | null;
	addedToDoNotCall: boolean;
	/** true - this was the last lead in the queue and the campaign was finished. */
	campaignFinished: boolean;
	/** When the lead goes back into the queue; null when it does not. */
	nextAttemptAt: Date | null;
}

/** Lead states that still owe the campaign a dial. */
const OPEN_LEAD_STATES = ["pending", "calling"] as const;

/** The transaction handle db.transaction hands its callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Finish a running campaign whose queue has just emptied.
 *
 * Counted and written inside the caller's transaction, guarded on `status =
 * 'running'`: two outcomes landing at the same moment would otherwise both see an
 * empty queue, and the campaign would be finished twice with two audit stories.
 */
async function finishIfQueueEmpty(
	tx: Tx,
	tenantId: TenantId,
	campaignId: string,
	now: Date
): Promise<boolean> {
	const [openRows] = await tx
		.select({ value: count() })
		.from(campaignLeads)
		.where(
			tenantWhere(
				campaignLeads,
				tenantId,
				eq(campaignLeads.campaignId, campaignId),
				inArray(campaignLeads.status, [...OPEN_LEAD_STATES])
			)
		);

	if (Number(openRows?.value ?? 0) > 0) {
		return false;
	}

	const finished = await tx
		.update(callCampaigns)
		.set({ status: "finished", endedAt: now, updatedAt: now })
		.where(
			tenantWhere(
				callCampaigns,
				tenantId,
				eq(callCampaigns.id, campaignId),
				eq(callCampaigns.status, "running")
			)
		)
		.returning({ id: callCampaigns.id });

	return finished.length > 0;
}

export async function recordDialOutcome(
	input: RecordDialOutcomeInput
): Promise<RecordDialOutcomeResult> {
	const now = input.now ?? new Date();

	const lead = await db.query.campaignLeads.findFirst({
		where:
			input.tenantId === undefined
				? eq(campaignLeads.id, input.leadId)
				: tenantWhere(campaignLeads, input.tenantId, eq(campaignLeads.id, input.leadId)),
	});

	if (lead === undefined) {
		// 404 either way, which is also the right answer for another tenant's leadId:
		// confirming it exists would be a fact about their queue.
		throw notFound("Kampaniya ro'yxatidagi yozuv", input.leadId);
	}

	// From here on the tenant is the LEAD's, never the caller's claim. The two are
	// already equal when input.tenantId was given (the lookup enforced it), and this
	// is the only source available when it was not.
	const tenantId = lead.tenantId;

	const campaign = await db.query.callCampaigns.findFirst({
		where: tenantWhere(callCampaigns, tenantId, eq(callCampaigns.id, lead.campaignId)),
	});

	if (campaign === undefined) {
		throw notFound("Kampaniya", lead.campaignId);
	}

	const attempts = input.countAttempt ? lead.attempts + 1 : lead.attempts;
	const plan = retryPlan({
		attempts,
		maxAttempts: campaign.maxAttempts,
		retryDelayMinutes: campaign.retryDelayMinutes,
		outcome: input.outcome,
		now,
	});

	// The do-not-call row goes in FIRST, before the lead is even updated. If anything
	// after this fails, the number is on the list and nobody rings it again - the
	// wrong way round would leave the outcome recorded and the person unprotected.
	let addedToDoNotCall = false;

	if (input.outcome === "do_not_call") {
		const added = await addToDoNotCall({
			tenantId,
			phoneNumber: lead.phoneNumber,
			reason: input.detail ?? "Qo'ng'iroq vaqtida «boshqa qo'ng'iroq qilmang» deb aytdi",
			source:
				input.recordedBy === undefined || input.recordedBy === null ? "asked_on_call" : "manual",
			callId: input.callId ?? null,
			createdBy: input.recordedBy ?? null,
		});

		addedToDoNotCall = added !== null;
	}

	const result = await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(campaignLeads)
			.set({
				status: plan.status,
				outcome: input.outcome,
				attempts,
				lastAttemptAt: input.countAttempt ? now : lead.lastAttemptAt,
				nextAttemptAt: plan.nextAttemptAt,
				// The lead points at the most recent call — every call is in the attempt
				// history. A hand-recorded outcome carries no call, so the old link stays.
				callId: input.callId ?? lead.callId,
				note: input.note === undefined ? lead.note : input.note,
				updatedAt: now,
			})
			.where(tenantWhere(campaignLeads, tenantId, eq(campaignLeads.id, lead.id)))
			.returning();

		if (updated === undefined) {
			throw notFound("Kampaniya ro'yxatidagi yozuv", lead.id);
		}

		let attemptId: string | null = null;

		if (input.countAttempt) {
			const [attempt] = await tx
				.insert(campaignCallAttempts)
				.values({
					// From the lead, which is the row this attempt is an attempt AT.
					tenantId,
					campaignId: lead.campaignId,
					leadId: lead.id,
					attemptNo: attempts,
					callId: input.callId ?? null,
					outcome: input.outcome,
					detail: input.detail ?? null,
					dialedAt: lead.lastAttemptAt ?? now,
					endedAt: now,
				})
				.returning({ id: campaignCallAttempts.id });

			attemptId = attempt?.id ?? null;
		}

		const campaignFinished =
			campaign.status === "running"
				? await finishIfQueueEmpty(tx, tenantId, lead.campaignId, now)
				: false;

		return { lead: updated, attemptId, campaignFinished };
	});

	return {
		lead: result.lead,
		attemptId: result.attemptId,
		addedToDoNotCall,
		campaignFinished: result.campaignFinished,
		nextAttemptAt: plan.nextAttemptAt,
	};
}
