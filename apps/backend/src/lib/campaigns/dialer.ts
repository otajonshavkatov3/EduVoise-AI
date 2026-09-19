/**
 * The runner: the loop that turns a campaign into calls.
 *
 * Everything the campaign tables promise is either enforced here or it is
 * decoration. A window stored on a row does not stop a 03:00 call; a do-not-call
 * list nobody consults does not stop a re-dial; an attempt limit nothing counts
 * does not stop a loop. So this file is deliberately the only place that claims
 * a lead and the only place that asks the telephony layer to ring anybody, and
 * every rule it applies comes from lib/campaigns rather than being restated:
 *
 *   planCampaignTick   window, concurrency, attempt-delay, and the stop
 *                      condition - pure, and tested on its own.
 *   checkDialAllowed   the do-not-call gate, called immediately before EVERY
 *                      originate, never at claim time and never at import time.
 *   recordDialOutcome  the one writer for the lead, the attempt row and the
 *                      do-not-call entry, so the queue and the list cannot
 *                      disagree.
 *   retryPlan          reached through recordDialOutcome; it is what writes the
 *                      delay this loop's claim query then waits for.
 *
 * HOW TWO TICKS CANNOT DIAL THE SAME PERSON
 *
 * One statement claims work (see `claimLeads`): a single UPDATE whose row set
 * comes from a `SELECT ... FOR UPDATE SKIP LOCKED` sub-query and which re-checks
 * `status = 'pending'` on the outer update. Two overlapping claims cannot
 * collide: the second transaction's sub-query skips the rows the first has
 * locked, and in the case where the first has already committed, the outer
 * predicate no longer matches because the row now says `calling`. There is no
 * application-level lock and none is needed - the claim IS the lock, and it is
 * held in a column, so it survives this process dying.
 *
 * WHAT HAPPENS WHEN THIS PROCESS DIES MID-CALL
 *
 * A lead sits in `calling` with nobody watching it. Two things must be true and
 * both are: it must not stay there for ever, and it must not be dialled a second
 * time while the first call is still up. `reclaimStaleClaims` handles the first
 * by requeueing claims older than STALE_CLAIM_MINUTES - through
 * recordDialOutcome with the attempt COUNTED, because the phone may well have
 * rung and the conservative direction is fewer calls, not more. The second is
 * handled by that same age threshold (longer than any ring plus any call) and by
 * `inFlight`, the set of leads this process is currently working, which the
 * reclaim never touches.
 *
 * WHERE THE TENANT COMES FROM - THERE IS NO REQUEST HERE
 *
 * This is a timer. Nobody is logged in, so there is no token to read a tenant
 * from, and nothing in this file may guess one. The chain is:
 *
 *   runDialerTick     reads `call_campaigns WHERE status = 'running'` across EVERY
 *                     tenant. That query is deliberately unscoped and it is the
 *                     ONLY one: one dialer process serves the whole platform, so
 *                     "which campaigns are running" is a platform question. Each
 *                     row it returns carries `campaign.tenant_id`.
 *   everything else   takes the tenant from that row - the lead claim, the four
 *                     counts, the concurrency count, the settings and timezone
 *                     read, the halt, the audit row, the dial. A campaign is owned
 *                     by exactly one customer, so the campaign row IS the
 *                     authority, and no value here is derived from a lead, a phone
 *                     number or an in-memory map.
 *   reclaimStaleClaims  sweeps `calling` claims across every tenant on purpose (an
 *                     abandoned claim must be rescued whoever owns it) and carries
 *                     each row's own tenant_id forward into recordDialOutcome.
 *
 * THE CONCURRENCY CEILING IS PER TENANT, not per platform. `outbound.
 * maxConcurrentCalls` is a per-tenant setting, so counting live dials across every
 * customer would let one busy customer's traffic stop everybody else's campaigns -
 * and would let them read a number that is a fact about somebody else's dialling.
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import pino from "pino";
import pretty from "pino-pretty";

import { db } from "@/db";
import type { CallCampaignRecord } from "@/db/schema";
import { auditLogs, callCampaigns, campaignLeads } from "@/db/schema";
import { getAiRuntimeConfig, refreshAiRuntimeConfig } from "@/lib/settings";
import type {
	OutboundCallPurpose,
	OutboundOptOutEntry,
	OutboundOutcomeEvent,
} from "@/lib/telephony";
import {
	getCallOrchestrator,
	isTrunkConfigured,
	placeOutboundCall,
	resolveOutboundCampaignKind,
	setOutboundDialerHooks,
} from "@/lib/telephony";
import { type TenantId, tenantWhere } from "@/lib/tenancy";

import { addToDoNotCall, checkDialAllowed, isDoNotCall } from "./do-not-call";
import { type DialerBlockReason, planCampaignTick, type TickPlan } from "./eligibility";
import { recordDialOutcome } from "./outcome";
import { buildLeadNote, toCampaignOutcome } from "./outcome-map";
import { normalisePhone } from "./phone";
import { describeWindow, resolveTenantTimeZone } from "./window";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{ level: isProduction ? "info" : "debug", name: "campaigns:dialer" },
	isProduction ? undefined : pretty({ colorize: true })
);

// ===========================================
// Tuning
// ===========================================

/**
 * How often the queue is looked at.
 *
 * Five seconds, not one: a tick that finds nothing to do costs two small
 * queries, and the thing it is waiting for - a retry delay measured in minutes,
 * a window that opens on the hour - never needs finer resolution than this. It
 * is also the worst-case delay between a call ending and the next one starting,
 * which at a concurrency of one is the pace of the whole campaign.
 */
const TICK_INTERVAL_MS = 5_000;

/**
 * The wait between two originates inside one tick.
 *
 * The concurrency ceiling already bounds how many calls exist at once; this
 * bounds how fast they are created. Opening several Gemini Live sessions in the
 * same instant is what gets a project rate-limited, and a throttled session is
 * money spent on a call that never happens.
 */
const DIAL_STAGGER_MS = 750;

/**
 * How long a `calling` claim may be silent before it is treated as abandoned.
 *
 * Ten minutes, deliberately the SAME number as STALE_CALLING_MINUTES in
 * routes/campaigns/campaigns.schemas.ts, so the "stuck" count the campaign page
 * shows and the moment this loop actually rescues the row agree. It is also
 * comfortably longer than a ring timeout plus a conversation, so a claim this
 * old cannot be a live call - and a live call of this process is excluded by
 * `inFlight` regardless.
 */
const STALE_CLAIM_MINUTES = 10;

const MS_PER_MINUTE = 60_000;

/** Internal PJSIP extensions are three digits here; see lib/campaigns/phone.ts. */
const EXTENSION_DIGITS = 3;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

// ===========================================
// Raw SQL row shapes
//
// The two statements below are hand-written SQL - one because the claim has to be
// a single atomic UPDATE ... FOR UPDATE SKIP LOCKED, the other because four
// counts in one round trip is one FILTER query and four drizzle calls otherwise.
// Postgres hands back its own column names, so these keys are snake_case by
// necessity: renaming them would mean the type no longer describes what arrives.
// ===========================================

// Type aliases rather than interfaces, and not by preference: db.execute()
// constrains its row type to Record<string, unknown>, which TypeScript satisfies
// with an implicit index signature for a type literal and refuses for an
// interface.
// biome-ignore-start lint/style/useNamingConvention: Postgres column names, not identifiers we chose.
type ClaimedLeadRow = {
	id: string;
	phone_number: string;
	full_name: string | null;
	variables: Record<string, string> | null;
	note: string | null;
	attempts: number;
};

type LeadCountRow = {
	open_leads: string;
	pending_reachable: string;
	due_reachable: string;
	calling_in_db: string;
};
// biome-ignore-end lint/style/useNamingConvention: end of the raw row shapes.

// ===========================================
// Process state
// ===========================================

interface InFlightLead {
	/** Whose campaign this dial belongs to. Taken from the campaign row, never a lead. */
	tenantId: TenantId;
	campaignId: string;
	leadId: string;
	phone: string;
	claimedAtMs: number;
	/** Set by the outcome hook, so a refusal path knows the result is already written. */
	settled: boolean;
}

interface DialerState {
	timer: ReturnType<typeof setInterval> | null;
	ticking: boolean;
	startedAt: Date | null;
	lastTickAt: Date | null;
	lastError: string | null;
	ticks: number;
	dialsPlaced: number;
	/** Leads this process is working right now, keyed by lead id. */
	inFlight: Map<string, InFlightLead>;
	/** The last decision per campaign, so an unchanged block is not logged every tick. */
	lastBlock: Map<string, DialerBlockReason | null>;
}

/**
 * `bun --hot` re-evaluates a module on save, and a module-level `let` would then
 * start a SECOND interval while the first kept running - two dialers claiming
 * from one queue. The same globalThis key the notification monitor and the voice
 * bootstrap use, for the same reason.
 */
const STATE_KEY = Symbol.for("callcenter.campaigns.dialerState");
const globalStore = globalThis as unknown as Record<symbol, DialerState | undefined>;

function state(): DialerState {
	const existing = globalStore[STATE_KEY];

	if (existing !== undefined) {
		return existing;
	}

	const created: DialerState = {
		timer: null,
		ticking: false,
		startedAt: null,
		lastTickAt: null,
		lastError: null,
		ticks: 0,
		dialsPlaced: 0,
		inFlight: new Map(),
		lastBlock: new Map(),
	};

	globalStore[STATE_KEY] = created;

	return created;
}

export interface DialerStatus {
	running: boolean;
	startedAt: string | null;
	lastTickAt: string | null;
	lastError: string | null;
	ticks: number;
	dialsPlaced: number;
	inFlight: number;
}

export function campaignDialerStatus(): DialerStatus {
	const current = state();

	return {
		running: current.timer !== null,
		startedAt: current.startedAt?.toISOString() ?? null,
		lastTickAt: current.lastTickAt?.toISOString() ?? null,
		lastError: current.lastError,
		ticks: current.ticks,
		dialsPlaced: current.dialsPlaced,
		inFlight: current.inFlight.size,
	};
}

// ===========================================
// The hooks the telephony layer calls back on
// ===========================================

/**
 * Where an outcome from the call path lands.
 *
 * Fires once per call, from whichever of the three ends the call reached: the
 * agent calling record_call_outcome, the teardown that reports "answered" when
 * it did not, or the channel giving up on a phone nobody picked up. All three
 * come through here so there is exactly one place that turns a call into a
 * campaign row.
 */
async function onOutcome(event: OutboundOutcomeEvent): Promise<void> {
	const leadId = event.leadId;

	if (leadId === null) {
		// A dial that belongs to no campaign - a manual test call. Nothing to record
		// against a queue; the call row already has the transcript and the cost.
		logger.debug({ callId: event.callId, outcome: event.outcome }, "outcome for a lead-less dial");
		return;
	}

	const outcome = toCampaignOutcome(event.outcome);
	const entry = state().inFlight.get(leadId);

	if (entry !== undefined) {
		entry.settled = true;
	}

	try {
		const result = await recordDialOutcome({
			leadId,
			outcome,
			callId: event.callId,
			detail: event.reason,
			note: buildLeadNote(outcome, event.reason, event.callBackAt),
			// A real dial happened, so it costs the lead one of its attempts. This is
			// what makes the attempt limit bite: retryPlan reads the new count and
			// either sets the next attempt or gives up on the lead.
			countAttempt: true,
		});

		logger.info(
			{
				callId: event.callId,
				campaignId: event.campaignId,
				leadId,
				outcome,
				source: event.source,
				attempts: result.lead.attempts,
				nextStatus: result.lead.status,
				nextAttemptAt: result.nextAttemptAt?.toISOString() ?? null,
				campaignFinished: result.campaignFinished,
				durationSeconds: event.durationSeconds,
			},
			"campaign lead outcome recorded"
		);

		if (event.callBackAt !== null && outcome === "callback_requested") {
			// Deliberately NOT turned into a scheduled retry. retryPlan treats every
			// answer a human gave as final, and re-queueing behind its back would race
			// the "the queue is empty, finish the campaign" check inside
			// recordDialOutcome - a finished campaign with a pending lead never ticks
			// again, so the person would be promised a call back and never get one. The
			// time is on the lead note instead, where a colleague acts on it.
			logger.info(
				{ leadId, callBackAt: event.callBackAt },
				"a call-back time was requested; recorded on the lead for a human to action"
			);
		}
	} catch (cause) {
		// Never thrown back at the call path: the call is over either way, and taking
		// down its teardown would lose the recording and the transcript too.
		logger.error(
			{ err: cause, callId: event.callId, leadId, outcome },
			"could not record a campaign outcome; the lead may need requeueing by hand"
		);
	} finally {
		release(leadId);
	}
}

/**
 * Somebody asked never to be called again.
 *
 * Throws when the write did not land, on purpose: the telephony layer catches it
 * and tells the person's own transcript that the promise was NOT kept, which is
 * the only honest thing to do. Swallowing it here would produce a call that says
 * "we have taken you off the list" over a list the number is not on.
 */
async function onOptOut(entry: OutboundOptOutEntry): Promise<void> {
	const added = await addToDoNotCall({
		tenantId: entry.tenantId,
		phoneNumber: entry.phone,
		reason: entry.reason,
		// The person said it out loud on a recorded line. That source can never be
		// deleted, which is the whole point of distinguishing it from a typed entry.
		source: "asked_on_call",
		callId: entry.callId,
		createdBy: null,
	});

	if (added === null) {
		throw new Error(`could not add ${entry.phone} to the do-not-call list`);
	}

	logger.warn(
		{
			phone: entry.phone,
			callId: entry.callId,
			campaignId: entry.campaignId,
			created: added.created,
			leadsSkipped: added.leadsSkipped,
		},
		"a person asked not to be called again; the number is on the do-not-call list and out of every queue"
	);
}

/**
 * The membership check the telephony layer runs before every dial of its own.
 *
 * Normalises first. The number reaching this hook is whatever was dialled with
 * its non-digits stripped, and a bare national number ("905706507") is a
 * different string from the stored form ("998905706507") - checking the raw
 * digits would sail straight past a person who had asked to be left alone.
 */
async function onDoNotCallCheck(tenantId: TenantId, phone: string): Promise<boolean> {
	const normalised = normalisePhone(phone);

	if (!normalised.ok) {
		// A number that will not normalise cannot be compared against the list at
		// all, and the old fallback - a membership lookup on the raw string - could
		// never match a stored number, so it passed everything. Refusing is the same
		// fail-closed rule this hook applies to a check that throws: the cost of a
		// wrong refusal is one undialled row, the cost of a wrong pass is ringing
		// somebody who asked not to be rung.
		logger.warn(
			{ phone, reason: normalised.message },
			"refusing an unnormalisable number: it cannot be checked against the do-not-call list"
		);

		return true;
	}

	return await isDoNotCall(tenantId, normalised.phone);
}

/** Register the campaign side with the telephony layer. Idempotent. */
export function registerCampaignDialerHooks(): void {
	setOutboundDialerHooks({
		recordOutcome: onOutcome,
		isDoNotCall: onDoNotCallCheck,
		addToDoNotCall: onOptOut,
	});
}

// ===========================================
// Claiming
// ===========================================

interface ClaimedLead {
	id: string;
	phoneNumber: string;
	fullName: string | null;
	variables: Record<string, string> | null;
	note: string | null;
	attempts: number;
}

/**
 * Take up to `limit` due leads out of the queue, atomically.
 *
 * See the file header for why this cannot double-dial. Three details that look
 * optional and are not:
 *
 *   FOR UPDATE SKIP LOCKED  makes a concurrent claim step over rows this one has
 *                           taken instead of blocking behind them, so two ticks
 *                           make progress rather than serialising.
 *   AND l.status='pending'  on the OUTER update, re-checked after the row lock is
 *                           granted. This is what covers the case the sub-query
 *                           cannot: a competing claim that had already committed
 *                           before this statement's snapshot was taken.
 *   WITH ... AS MATERIALIZED and NOT `WHERE id IN (SELECT ... LIMIT n FOR UPDATE
 *                           SKIP LOCKED)`, which is the obvious spelling and is
 *                           WRONG. It was written that way first and MEASURED:
 *                           asking for 2 of 5 due leads claimed all 5. `FOR
 *                           UPDATE` stops Postgres hashing an uncorrelated
 *                           `IN` sub-plan, so the sub-plan is rescanned per
 *                           outer row and the LIMIT selects a fresh two rows
 *                           each time - the ceiling silently stops existing,
 *                           which on this code path means the concurrency limit
 *                           and the AI provider's quota stop existing with it. A
 *                           materialised CTE is evaluated exactly once.
 *
 * `reachableOnly` is the no-trunk case. External numbers are not claimed at all
 * rather than claimed and failed: failing them would spend their attempts on a
 * condition that has nothing to do with the person, and the day a trunk is
 * bought those rows would already be exhausted.
 */
export async function claimLeads(
	tenantId: TenantId,
	campaignId: string,
	limit: number,
	reachableOnly: boolean,
	now: Date = new Date()
): Promise<ClaimedLead[]> {
	if (limit <= 0) {
		return [];
	}

	const reachable = reachableOnly
		? sql` AND char_length(c.phone_number) = ${EXTENSION_DIGITS}`
		: sql``;

	const result = await db.execute<ClaimedLeadRow>(sql`
		WITH due AS MATERIALIZED (
			SELECT c.id
			FROM campaign_leads AS c
			WHERE c.tenant_id = ${tenantId}
				AND c.campaign_id = ${campaignId}
				AND c.status = 'pending'
				AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= ${now})${reachable}
			ORDER BY c.next_attempt_at ASC NULLS FIRST, c.created_at ASC
			LIMIT ${limit}
			FOR UPDATE SKIP LOCKED
		)
		UPDATE campaign_leads AS l
		SET status = 'calling', last_attempt_at = ${now}, updated_at = ${now}
		FROM due
		WHERE l.id = due.id
			AND l.tenant_id = ${tenantId}
			AND l.status = 'pending'
		RETURNING l.id, l.phone_number, l.full_name, l.variables, l.note, l.attempts
	`);

	return result.rows.map((row) => ({
		id: row.id,
		phoneNumber: row.phone_number,
		fullName: row.full_name,
		variables: row.variables,
		note: row.note,
		attempts: Number(row.attempts),
	}));
}

/** Put a claimed lead back without spending an attempt. Used when the fault is ours. */
async function requeue(tenantId: TenantId, leadId: string, reason: string): Promise<void> {
	await db
		.update(campaignLeads)
		.set({ status: "pending", nextAttemptAt: null, updatedAt: new Date() })
		.where(
			tenantWhere(
				campaignLeads,
				tenantId,
				eq(campaignLeads.id, leadId),
				eq(campaignLeads.status, "calling")
			)
		);

	logger.warn({ leadId, reason }, "a claimed lead was put back in the queue");
}

function release(leadId: string): void {
	state().inFlight.delete(leadId);
}

// ===========================================
// Restart safety
// ===========================================

/**
 * Rescue leads left in `calling` by a process that is no longer running.
 *
 * Run on every tick rather than only at boot, because the crash is not the only
 * way a claim is orphaned: a call whose outcome hook threw, an ARI event that
 * never arrived, an Asterisk restart mid-ring. The outcome written is `failed`
 * with the attempt COUNTED - the phone may have rung, and a rescue that gave the
 * attempt back would let a crash loop ring the same person indefinitely.
 */
export async function reclaimStaleClaims(now: Date = new Date()): Promise<number> {
	const current = state();
	const staleBefore = new Date(now.getTime() - STALE_CLAIM_MINUTES * MS_PER_MINUTE);
	const mine = [...current.inFlight.keys()];

	// Platform-wide ON PURPOSE, and one of only two reads in this file that are: an
	// abandoned claim has to be rescued whoever owns it, and nobody is asking. The
	// tenant is then carried per row - `tenantId` below is the LEAD's own column,
	// which is why this sweep can act for many customers without ever mixing two.
	const stale = await db
		.select({
			id: campaignLeads.id,
			campaignId: campaignLeads.campaignId,
			tenantId: campaignLeads.tenantId,
		})
		.from(campaignLeads)
		.where(
			and(
				eq(campaignLeads.status, "calling"),
				sql`(${campaignLeads.lastAttemptAt} IS NULL OR ${campaignLeads.lastAttemptAt} < ${staleBefore})`,
				// A call this process is still working is not stale however long it runs.
				mine.length === 0 ? undefined : notInArray(campaignLeads.id, mine)
			)
		);

	if (stale.length === 0) {
		return 0;
	}

	logger.warn(
		{ count: stale.length, staleBefore: staleBefore.toISOString() },
		"found abandoned lead claims; requeueing them"
	);

	let rescued = 0;

	for (const lead of stale) {
		try {
			await recordDialOutcome({
				tenantId: lead.tenantId,
				leadId: lead.id,
				outcome: "failed",
				detail: `Qo'ng'iroq natijasi kelmadi (${STALE_CLAIM_MINUTES} daqiqadan ortiq javobsiz qoldi) — tizim qayta ishga tushgan bo'lishi mumkin`,
				note: "Qo'ng'iroq yakunlanmadi — navbatga qaytarildi",
				countAttempt: true,
				now,
			});

			rescued += 1;
		} catch (cause) {
			logger.error({ err: cause, leadId: lead.id }, "could not requeue an abandoned claim");
		}
	}

	pruneInFlight(now);

	return rescued;
}

/**
 * Drop in-memory entries whose outcome hook never fired at all.
 *
 * A leak guard, and its horizon is the reason it is a function rather than a
 * line: it MUST be longer than the longest call this platform allows. An entry
 * in `inFlight` is what stops the sweep above requeueing a lead whose call is
 * still up, and `ai.maxCallSeconds` is 900 here - fifteen minutes, longer than
 * STALE_CLAIM_MINUTES. Pruning on the shorter number would expose a live
 * twelve-minute conversation to being requeued and then dialled a second time,
 * which is exactly the failure this whole mechanism exists to prevent.
 */
function pruneInFlight(now: Date): void {
	const current = state();

	for (const [leadId, entry] of current.inFlight) {
		// The horizon is read from the OWNING TENANT's own limits, not from a platform
		// guess: maxCallSeconds and the ring timeout are per-tenant settings, and a
		// horizon shorter than that customer's longest permitted call would forget a
		// live conversation and expose it to being requeued and dialled twice. The
		// entry carries the tenant from the campaign row it was claimed for, so there is
		// nothing to guess and no sole-tenant seam left on this path.
		const ai = getAiRuntimeConfig(entry.tenantId);
		const horizonMs =
			STALE_CLAIM_MINUTES * MS_PER_MINUTE +
			(ai.maxCallSeconds + ai.outbound.ringTimeoutSeconds) * 1_000;

		if (now.getTime() - entry.claimedAtMs > horizonMs) {
			logger.warn(
				{ leadId, campaignId: entry.campaignId, phone: entry.phone },
				"a dial never reported an outcome; forgetting it so it stops holding a concurrency slot"
			);
			current.inFlight.delete(leadId);
		}
	}
}

// ===========================================
// One dial
// ===========================================

/** What the agent is told about this call. Composed from the campaign and the lead. */
function buildPurpose(campaign: CallCampaignRecord, lead: ClaimedLead): OutboundCallPurpose {
	return {
		kind: resolveOutboundCampaignKind(campaign.kind),
		campaignName: campaign.name,
		purpose: campaign.purpose,
		script: campaign.script,
		// The platform composes the opening line from the purpose. A campaign has no
		// column for a verbatim first sentence, and inventing one out of `script`
		// would put a paragraph of talking points into the first thing the person
		// hears.
		openingLine: null,
		leadName: lead.fullName,
		variables: lead.variables ?? {},
		notes: lead.note,
	};
}

/**
 * Ring one claimed lead.
 *
 * The do-not-call gate is the first thing here and not one line earlier: between
 * the claim and this moment somebody else's call may have ended with "take me
 * off your list", and the whole promise of that list is that it is true from the
 * second it is written, not from the next import.
 */
async function dialLead(campaign: CallCampaignRecord, lead: ClaimedLead): Promise<boolean> {
	const current = state();

	current.inFlight.set(lead.id, {
		// From the campaign row, which is the only authority on whose dial this is.
		tenantId: campaign.tenantId,
		campaignId: campaign.id,
		leadId: lead.id,
		phone: lead.phoneNumber,
		claimedAtMs: Date.now(),
		settled: false,
	});

	const gate = await checkDialAllowed(campaign.tenantId, lead.phoneNumber);

	if (!gate.allowed) {
		// Neither refusal is a dial, so neither spends an attempt: retryPlan takes
		// `do_not_call` out of the queue as `skipped` and an unusable number to
		// `failed`, and both are final without needing the attempt counter.
		await recordDialOutcome({
			tenantId: campaign.tenantId,
			leadId: lead.id,
			outcome: gate.reason,
			detail: gate.message,
			note: gate.message,
			countAttempt: false,
		});

		logger.info(
			{ campaignId: campaign.id, leadId: lead.id, phone: lead.phoneNumber, reason: gate.reason },
			"a lead was not dialled"
		);

		release(lead.id);

		return false;
	}

	const result = await placeOutboundCall({
		// From the campaign row: the dial pattern (hence the trunk), the caller id and
		// the agent that speaks are all this customer's own.
		tenantId: campaign.tenantId,
		number: gate.phone,
		purpose: buildPurpose(campaign, lead),
		campaignId: campaign.id,
		leadId: lead.id,
		// Who authorised the ringing and the spending. Written onto the call as a
		// note, so /calls/:id explains itself months later with nothing to join.
		requestedByUserId: campaign.startedBy,
	});

	if (result.placed) {
		state().dialsPlaced += 1;

		logger.info(
			{
				campaignId: campaign.id,
				leadId: lead.id,
				callId: result.callId,
				endpoint: result.endpoint,
				phone: result.phone,
				attempt: lead.attempts + 1,
				maxAttempts: campaign.maxAttempts,
			},
			"campaign call placed"
		);

		// The outcome arrives on the hook - from the conversation, the teardown or the
		// channel. The lead stays claimed until then, which is what holds its slot in
		// both concurrency budgets.
		return true;
	}

	// The dial was refused. Some refusals were already reported through the hook by
	// the telephony layer (it writes a call row, a note and an outcome for an
	// originate Asterisk rejected), so recording again here would double-count the
	// attempt and overwrite the more specific reason with a vaguer one.
	const entry = current.inFlight.get(lead.id);
	const alreadyRecorded = entry === undefined || entry.settled;

	logger.warn(
		{
			campaignId: campaign.id,
			leadId: lead.id,
			refusal: result.refusal,
			outcome: result.outcome,
			callId: result.callId,
			alreadyRecorded,
			message: result.message,
		},
		"campaign call was refused"
	);

	if (alreadyRecorded) {
		release(lead.id);

		return false;
	}

	if (result.outcome === null) {
		// Our fault, not the lead's - the voice layer is not running. The lead goes
		// back untouched rather than spending an attempt on our outage.
		await requeue(campaign.tenantId, lead.id, result.refusal);
		release(lead.id);

		return false;
	}

	await recordDialOutcome({
		tenantId: campaign.tenantId,
		leadId: lead.id,
		outcome: toCampaignOutcome(result.outcome),
		callId: result.callId,
		detail: result.message,
		note: result.message,
		// A dial was genuinely attempted and Asterisk refused it. Counting it is what
		// bounds the retries on an endpoint that is simply not there.
		countAttempt: true,
	});

	release(lead.id);

	return false;
}

// ===========================================
// One tick
// ===========================================

export interface CampaignCounts {
	openLeads: number;
	pendingReachable: number;
	dueReachable: number;
	callingInDb: number;
}

/**
 * Every lead number this campaign's plan needs, in one query.
 *
 * One round trip rather than four counts: the tick runs for every running
 * campaign every few seconds, and `idx_campaign_leads_due` serves all of these
 * off its `(campaign_id, status)` prefix.
 *
 * EXPORTED FOR ONE REASON: it is hand-written SQL, so its `tenant_id = $1` is
 * checked by nothing. The compiler sees an SQL fragment, and lib/tenancy's query
 * scanner reads source text and cannot judge a string template. These counts decide
 * how many people this campaign rings, so the tenant term is guarded by
 * tests/integration/tenant-ai-boundary.test.ts instead - the same reason claimLeads
 * and reclaimStaleClaims are exported.
 */
export async function countCampaignLeads(
	tenantId: TenantId,
	campaignId: string,
	reachableOnly: boolean,
	now: Date
): Promise<CampaignCounts> {
	const reachable = reachableOnly
		? sql`char_length(phone_number) = ${EXTENSION_DIGITS}`
		: sql`true`;

	const result = await db.execute<LeadCountRow>(sql`
		SELECT
			count(*) FILTER (WHERE status IN ('pending', 'calling')) AS open_leads,
			count(*) FILTER (WHERE status = 'pending' AND ${reachable}) AS pending_reachable,
			count(*) FILTER (
				WHERE status = 'pending'
					AND ${reachable}
					AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
			) AS due_reachable,
			count(*) FILTER (WHERE status = 'calling') AS calling_in_db
		FROM campaign_leads
		WHERE tenant_id = ${tenantId}
			AND campaign_id = ${campaignId}
	`);

	const row = result.rows[0];

	return {
		openLeads: Number(row?.open_leads ?? 0),
		pendingReachable: Number(row?.pending_reachable ?? 0),
		dueReachable: Number(row?.due_reachable ?? 0),
		callingInDb: Number(row?.calling_in_db ?? 0),
	};
}

/**
 * ONE TENANT's outbound calls that are genuinely out, from the database's view.
 *
 * Per tenant, and that is a correctness rule rather than tidiness: the ceiling
 * this number is compared against is `outbound.maxConcurrentCalls`, a PER-TENANT
 * setting. Counted across the platform, one busy customer's four live calls would
 * exhaust every other customer's budget of three and silently stop their
 * campaigns - and the number itself is a fact about somebody else's dialling.
 *
 * BOTH SIDES OF THE JOIN ARE SCOPED. This is raw SQL, so the type checker and the
 * query scanner can say nothing about it; scoping only `campaign_leads` would
 * still admit a `call_campaigns` row of another tenant if a lead ever pointed at
 * one, so the predicate is written on both tables.
 *
 * The rest of the filter is unchanged and still load-bearing: an unqualified
 * `count(*) where status = 'calling'` also counts rows abandoned by a crashed
 * process and rows of a campaign that is no longer running - neither is a live
 * call, and a handful of orphans from one hard restart was enough to stop a
 * campaign until the ten-minute reclaim ran.
 *
 * Exported for the same reason countCampaignLeads is: raw SQL with a JOIN in it is
 * the one shape neither the type checker nor the query scanner can say anything
 * about, so the two predicates are asserted by a test that runs the real statement.
 */
export async function countTenantCalling(tenantId: TenantId): Promise<number> {
	const result = await db.execute<{ value: string }>(sql`
		SELECT count(*) AS value
		FROM campaign_leads l
		JOIN call_campaigns c ON c.id = l.campaign_id AND c.tenant_id = ${tenantId}
		WHERE l.tenant_id = ${tenantId}
		  AND l.status = 'calling'
		  AND c.status = 'running'
		  AND l.last_attempt_at > now() - (${STALE_CLAIM_MINUTES} * interval '1 minute')
	`);

	return Number(result.rows[0]?.value ?? 0);
}

/**
 * Stop a campaign that can never place a call, and leave the reason behind.
 *
 * Paused rather than cancelled: cancelled is terminal in the transition table,
 * and the condition that caused this - a missing SIP trunk - is one the owner
 * fixes in an afternoon, after which they must be able to press start again on
 * the list they already imported.
 */
async function haltCampaign(campaign: CallCampaignRecord, plan: TickPlan): Promise<void> {
	const now = new Date();

	// Guarded on `running` so a human pausing or cancelling in the same second is
	// not overwritten by the dialer's own decision.
	const changed = await db
		.update(callCampaigns)
		.set({ status: "paused", pausedAt: now, updatedAt: now })
		.where(
			tenantWhere(
				callCampaigns,
				campaign.tenantId,
				eq(callCampaigns.id, campaign.id),
				eq(callCampaigns.status, "running")
			)
		)
		.returning({ id: callCampaigns.id });

	if (changed.length === 0) {
		return;
	}

	// The audit trail requirement: who started it is already on the campaign, and
	// this row records that the PLATFORM stopped it and exactly why. Written
	// directly rather than through lib/audit, which needs an HTTP request there is
	// none of here; the row belongs to this feature.
	await db.insert(auditLogs).values({
		// The campaign's own tenant on both columns: the platform's dialer acted, but
		// it acted as part of that customer's own campaign, not as the vendor.
		tenantId: campaign.tenantId,
		actorTenantId: campaign.tenantId,
		userId: campaign.startedBy,
		action: "campaign.dialer.halted",
		entityType: "call_campaign",
		entityId: campaign.id,
		details: {
			name: campaign.name,
			reason: plan.blocked,
			message: plan.message,
			trunkConfigured: isTrunkConfigured(),
		},
	});

	logger.error(
		{ campaignId: campaign.id, name: campaign.name, reason: plan.blocked },
		plan.message
	);
}

/** Log a block once per change rather than every five seconds. */
function noteBlock(campaignId: string, plan: TickPlan): void {
	const current = state();

	if (current.lastBlock.get(campaignId) === plan.blocked) {
		return;
	}

	current.lastBlock.set(campaignId, plan.blocked);

	if (plan.blocked !== null) {
		logger.info({ campaignId, reason: plan.blocked }, plan.message);
	}
}

async function tickCampaign(
	campaign: CallCampaignRecord,
	context: {
		now: Date;
		timeZone: string;
		telephonyRunning: boolean;
		trunkConfigured: boolean;
		platformConcurrency: number;
		tenantCallingInDb: number;
	}
): Promise<number> {
	const reachableOnly = !context.trunkConfigured;
	const counts = await countCampaignLeads(
		campaign.tenantId,
		campaign.id,
		reachableOnly,
		context.now
	);
	const orchestrator = getCallOrchestrator();

	// The larger of the two counts, always. The database drops a lead the moment
	// the agent records an outcome, which happens mid-conversation while the
	// channel is still up and still costing money; the orchestrator misses nothing
	// live but knows nothing about another process. Taking the max means the budget
	// is never overspent, only ever under-used for a few seconds.
	const campaignInFlight = Math.max(
		counts.callingInDb,
		orchestrator.countOutboundInFlight(campaign.id)
	);
	// The orchestrator's in-memory count is process-wide and not tenant-aware, so it
	// is the conservative half of a max() against the tenant-scoped database count:
	// over-counting delays a dial by a tick, under-counting overspends a customer's
	// concurrency budget. TODO(tenancy): lib/telephony/call-orchestrator's
	// countOutboundInFlight() should take a tenant so this max is apples to apples.
	const platformInFlight = Math.max(
		context.tenantCallingInDb,
		orchestrator.countOutboundInFlight()
	);

	const plan = planCampaignTick({
		status: campaign.status,
		telephonyRunning: context.telephonyRunning,
		window: describeWindow(
			{ start: campaign.callWindowStart, end: campaign.callWindowEnd },
			context.timeZone,
			context.now
		),
		campaignConcurrency: campaign.concurrency,
		platformConcurrency: context.platformConcurrency,
		counts: {
			openLeads: counts.openLeads,
			pendingReachable: counts.pendingReachable,
			dueReachable: counts.dueReachable,
			campaignInFlight,
			platformInFlight,
		},
	});

	noteBlock(campaign.id, plan);

	if (plan.halt) {
		await haltCampaign(campaign, plan);

		return 0;
	}

	if (plan.dial <= 0) {
		return 0;
	}

	const claimed = await claimLeads(
		campaign.tenantId,
		campaign.id,
		plan.dial,
		reachableOnly,
		context.now
	);

	if (claimed.length === 0) {
		return 0;
	}

	logger.info(
		{ campaignId: campaign.id, claimed: claimed.length, planned: plan.dial },
		"claimed leads to dial"
	);

	let placed = 0;

	for (const [index, lead] of claimed.entries()) {
		if (index > 0) {
			await wait(DIAL_STAGGER_MS);
		}

		try {
			if (await dialLead(campaign, lead)) {
				placed += 1;
			}
		} catch (cause) {
			// One lead must never take the rest of the campaign down with it.
			logger.error(
				{ err: cause, campaignId: campaign.id, leadId: lead.id },
				"dialling a lead threw; putting it back in the queue"
			);

			await requeue(campaign.tenantId, lead.id, "dial threw").catch(() => undefined);
			release(lead.id);
		}
	}

	return placed;
}

/**
 * One pass over every running campaign.
 *
 * Exported so a test and an operator can run exactly what the timer runs. Never
 * throws: a tick that fails is logged and the next one tries again, because the
 * alternative is a dialer that dies on one bad row and leaves a campaign half
 * called with nobody watching.
 */
export async function runDialerTick(now: Date = new Date()): Promise<number> {
	const current = state();

	if (current.ticking) {
		// Ticks must not overlap: two of them would each read the concurrency counts
		// before either had claimed anything, and both would dial up to the limit.
		return 0;
	}

	current.ticking = true;
	current.ticks += 1;
	current.lastTickAt = now;

	try {
		await reclaimStaleClaims(now);

		// THE ONE DELIBERATELY UNSCOPED READ IN THIS FILE. One dialer process serves
		// every customer, so "which campaigns are running" is a platform question and
		// there is no request to take a tenant from. Every row carries its own
		// tenant_id, and that column is the tenant for everything below - see the file
		// header.
		const running = await db
			.select()
			.from(callCampaigns)
			.where(eq(callCampaigns.status, "running"));

		if (running.length === 0) {
			current.lastError = null;

			return 0;
		}

		const context = {
			now,
			telephonyRunning: getCallOrchestrator().isRunning,
			trunkConfigured: isTrunkConfigured(),
		};

		/**
		 * Live dials already counted, PER TENANT.
		 *
		 * One entry per customer, filled lazily and then incremented by the dials this
		 * tick places. It used to be a single platform number, which meant two
		 * campaigns of two different customers spent the same budget: with the ceiling
		 * defaulting to 3, customer A dialling three leads stopped customer B's
		 * campaign dead. It is also read once per tenant rather than once per campaign,
		 * because a customer running two campaigns shares one ceiling between them.
		 */
		const callingByTenant = new Map<TenantId, number>();

		let placed = 0;

		for (const campaign of running) {
			// Per campaign, because a campaign belongs to a customer: the concurrency
			// ceiling, the timezone the call window is read in and the voice that speaks
			// are that customer's settings. Re-read on every tick, not cached at boot, so
			// a change on their settings page takes effect on the next tick.
			const config = await refreshAiRuntimeConfig(campaign.tenantId).catch(() =>
				getAiRuntimeConfig(campaign.tenantId)
			);

			let tenantCallingInDb = callingByTenant.get(campaign.tenantId);

			if (tenantCallingInDb === undefined) {
				tenantCallingInDb = await countTenantCalling(campaign.tenantId);
			}

			const dialled = await tickCampaign(campaign, {
				...context,
				timeZone: await resolveTenantTimeZone(campaign.tenantId),
				platformConcurrency: config.outbound.maxConcurrentCalls,
				tenantCallingInDb,
			});

			placed += dialled;
			// Each dial this tick placed is one more against THIS TENANT's ceiling. Without
			// this, two campaigns of the same customer in one tick would each be told the
			// customer has nothing out.
			callingByTenant.set(campaign.tenantId, tenantCallingInDb + dialled);
		}

		current.lastError = null;

		return placed;
	} catch (cause) {
		current.lastError = cause instanceof Error ? cause.message : String(cause);
		logger.error({ err: cause }, "a dialer tick failed; the next one will try again");

		return 0;
	} finally {
		current.ticking = false;
	}
}

// ===========================================
// Lifecycle
// ===========================================

/**
 * Start the loop and register the hooks.
 *
 * Registering the hooks is not optional and is done even when the loop is
 * already up: without them the telephony layer cannot enforce the do-not-call
 * list itself, and an opt-out taken from a person would be logged and dropped.
 */
export function startCampaignDialer(): void {
	registerCampaignDialerHooks();

	const current = state();

	if (current.timer !== null) {
		return;
	}

	current.startedAt = new Date();
	current.timer = setInterval(() => {
		// Fire and forget. runDialerTick owns its own errors; the catch is belt and
		// braces so an unexpected rejection can never become an unhandled one that
		// takes the process down mid-campaign.
		runDialerTick().catch((err: unknown) => {
			logger.error({ err }, "a dialer tick rejected unexpectedly");
		});
	}, TICK_INTERVAL_MS);

	// Bun keeps the process alive for a pending interval. This one must not be the
	// reason a shutdown hangs - the HTTP server is what holds the process open.
	const timer = current.timer as { unref?: () => void };

	timer.unref?.();

	logger.info({ intervalMs: TICK_INTERVAL_MS }, "campaign dialer started");
}

export function stopCampaignDialer(): void {
	const current = state();

	if (current.timer !== null) {
		clearInterval(current.timer);
		current.timer = null;
	}

	current.startedAt = null;
	current.lastBlock.clear();

	// inFlight is deliberately NOT cleared here. Shutdown calls this and then
	// releaseInFlightClaims(), which reads the very same map to requeue the leads
	// this process had out - clearing it first made that function a no-op on every
	// planned restart, so those leads sat in "calling" until the ten-minute stale
	// reclaim found them. releaseInFlightClaims clears the map itself.
	logger.info("campaign dialer stopped");
}

/**
 * Requeue everything this process has out, for a clean shutdown.
 *
 * Better than letting reclaimStaleClaims find them ten minutes later: a planned
 * restart should not cost the owner ten minutes of a campaign. Only rows this
 * process actually claimed are touched.
 */
export async function releaseInFlightClaims(): Promise<number> {
	const current = state();

	if (current.inFlight.size === 0) {
		return 0;
	}

	// Grouped by tenant so each UPDATE can name one, rather than one statement over a
	// mixed id list. The ids are this process's own claims and could not match another
	// customer's row anyway; writing the tenant is what keeps that true after the next
	// change to how inFlight is filled.
	const idsByTenant = new Map<TenantId, string[]>();

	for (const entry of current.inFlight.values()) {
		const bucket = idsByTenant.get(entry.tenantId);

		if (bucket === undefined) {
			idsByTenant.set(entry.tenantId, [entry.leadId]);
		} else {
			bucket.push(entry.leadId);
		}
	}

	current.inFlight.clear();

	let count = 0;

	for (const [tenantId, ids] of idsByTenant) {
		const requeued = await db
			.update(campaignLeads)
			.set({ status: "pending", nextAttemptAt: null, updatedAt: new Date() })
			.where(
				tenantWhere(
					campaignLeads,
					tenantId,
					inArray(campaignLeads.id, ids),
					eq(campaignLeads.status, "calling")
				)
			)
			.returning({ id: campaignLeads.id });

		count += requeued.length;
	}

	logger.info({ count }, "requeued in-flight claims for shutdown");

	return count;
}
