/**
 * May this campaign dial right now, and how many at once?
 *
 * Pure on purpose, and separated from the dialer that uses it, because this is
 * the whole safety argument of the feature written down in one place: the
 * calling window, the attempt budget, the concurrency ceilings and the decision
 * to stop a campaign that can never place a call. Everything here is a function
 * of numbers the dialer counted; nothing here reads a clock, a database or a
 * setting, so every rule below is testable without any of those.
 *
 * THE RULES ARE ENFORCED HERE AND ALSO STORED ELSEWHERE, AND THAT IS THE POINT
 *
 * `call_campaigns` carries the window, the attempt limit and the concurrency
 * number, and the API refuses to store a bad one. That is storage, not
 * enforcement: a row saying "09:00-18:00" does not stop anything happening at
 * 03:00. The dialer asks this function before every claim, so the stored value
 * becomes a rule at the only moment it matters - just before somebody's phone
 * rings.
 *
 * WHAT IS DELIBERATELY *NOT* DECIDED HERE
 *
 *   the do-not-call list  checked immediately before each dial, by
 *                         checkDialAllowed, because a number can arrive on it
 *                         two minutes after this plan was made. A tick-level
 *                         decision would be stale by the time the phone rang.
 *   the attempt delay     enforced by the claim query's `next_attempt_at <=
 *                         now()` predicate and written by retryPlan. This
 *                         function only sees how many leads came out of that
 *                         filter as `dueDialable`.
 */
import type { CampaignStatus } from "@/db/schema";

import type { WindowState } from "./window";

/**
 * Why a tick placed no calls, or fewer than the queue could have taken.
 *
 * A closed vocabulary rather than a message, so the dialer can log it, count it
 * and decide whether it is worth telling a human about. The message is for the
 * human; the reason is for the code.
 */
export type DialerBlockReason =
	| "campaign_not_running"
	| "telephony_down"
	| "queue_empty"
	| "no_reachable_leads"
	| "window_closed"
	| "nothing_due"
	| "campaign_concurrency"
	| "platform_concurrency";

export interface TickCounts {
	/** Leads still owing this campaign a dial: `pending` plus `calling`. */
	openLeads: number;
	/**
	 * `pending` leads this deployment could physically ring, whenever they come
	 * due. With no SIP trunk that means the internal extensions only - see the
	 * dialer's claim query, which applies the same filter in SQL.
	 */
	pendingReachable: number;
	/** The subset of `pendingReachable` whose retry delay has expired. */
	dueReachable: number;
	/** This campaign's calls that are already out - ringing or talking. */
	campaignInFlight: number;
	/** Every outbound call this platform has out, including other campaigns'. */
	platformInFlight: number;
}

export interface TickInput {
	status: CampaignStatus;
	/** False when the voice layer is down: nothing would answer the person. */
	telephonyRunning: boolean;
	window: WindowState;
	/** `call_campaigns.concurrency` - this campaign's own ceiling. */
	campaignConcurrency: number;
	/** `ai.outbound.maxConcurrentCalls` - the platform's ceiling over all campaigns. */
	platformConcurrency: number;
	counts: TickCounts;
}

export interface TickPlan {
	/** How many leads to claim and dial on this tick. Zero is a normal answer. */
	dial: number;
	/** Null when the plan is to dial; otherwise why not. */
	blocked: DialerBlockReason | null;
	/** Uzbek. Safe to log, to write to the audit trail and to show to the owner. */
	message: string;
	/**
	 * True when this campaign can never place a call as things stand, so the
	 * dialer must stop it and say so rather than come back in five seconds and
	 * find the same thing for ever.
	 */
	halt: boolean;
}

function ready(dial: number): TickPlan {
	return { dial, blocked: null, message: `${dial} ta raqamga qo'ng'iroq qilinadi.`, halt: false };
}

function blocked(reason: DialerBlockReason, message: string, halt = false): TickPlan {
	return { dial: 0, blocked: reason, message, halt };
}

/**
 * The whole tick decision, in the order the checks have to happen.
 *
 * Order is not cosmetic. The halt check sits ABOVE the window check so an owner
 * who launches an unreachable campaign at 22:00 is told immediately instead of
 * at nine the next morning; and it sits BELOW the empty-queue check so a
 * campaign that simply finished is never reported as broken.
 */
export function planCampaignTick(input: TickInput): TickPlan {
	const counts = input.counts;

	// 1. Only a running campaign dials. A paused one places no NEW calls - the
	//    calls it already has out are left alone to finish, which is why this is a
	//    decision about claiming rather than about hanging anything up.
	if (input.status !== "running") {
		return blocked(
			"campaign_not_running",
			`Kampaniya «${input.status}» holatida — yangi qo'ng'iroq qilinmaydi.`
		);
	}

	// 2. Nothing would answer the phone. Not the lead's fault and not permanent,
	//    so no attempt is spent and the campaign keeps its status.
	if (!input.telephonyRunning) {
		return blocked(
			"telephony_down",
			"Telefoniya xizmati ishlamayapti — qo'ng'iroqlar vaqtincha to'xtatildi, xizmat tiklanganda o'zi davom etadi."
		);
	}

	// 3. Nothing left to do. recordDialOutcome finishes the campaign as the last
	//    lead leaves the queue, so this is normally seen once, on the tick between
	//    the last outcome and the status change.
	if (counts.openLeads === 0) {
		return blocked("queue_empty", "Navbat bo'sh — hamma raqam qayta ishlangan.");
	}

	// 4. THE STOP CONDITION. There are leads left, nothing is out, and not one of
	//    them can be rung on this deployment - the trunk case: a list of mobile
	//    numbers with SIP_TRUNK_HOST empty. Every tick would otherwise find the
	//    same leads, dial nothing and come back, for ever. The dialer pauses the
	//    campaign on this and records why.
	if (counts.pendingReachable === 0 && counts.campaignInFlight === 0) {
		return blocked(
			"no_reachable_leads",
			"Navbatdagi raqamlarning birortasiga ham qo'ng'iroq qilib bo'lmaydi: tashqi liniya (SIP trunk) " +
				"sozlanmagan, ro'yxatda esa faqat mobil raqamlar bor. Kampaniya to'xtatildi. .env dagi " +
				"SIP_TRUNK_HOST, SIP_TRUNK_USERNAME, SIP_TRUNK_PASSWORD ni to'ldirib Asterisk'ni qayta ishga " +
				"tushiring, so'ng kampaniyani davom ettiring.",
			true
		);
	}

	// 5. Nobody is rung at 03:00. Evaluated against the tenant's wall clock, which
	//    is what the caller's own morning is measured in.
	if (!input.window.openNow) {
		return blocked("window_closed", input.window.message);
	}

	// 6. Leads exist but their retry delay has not expired. Distinct from an empty
	//    queue: this campaign will dial again by itself, without anyone doing
	//    anything.
	if (counts.dueReachable === 0) {
		return blocked(
			"nothing_due",
			"Hozir muddati kelgan raqam yo'q — qayta urinish vaqti kelganda qo'ng'iroqlar davom etadi."
		);
	}

	// 7. This campaign's own ceiling. One campaign must not take the whole trunk.
	const campaignSlots = input.campaignConcurrency - counts.campaignInFlight;

	if (campaignSlots <= 0) {
		return blocked(
			"campaign_concurrency",
			`Bir vaqtda ${input.campaignConcurrency} ta qo'ng'iroq chegarasi to'lgan — biri tugaganda keyingisi boshlanadi.`
		);
	}

	// 8. The platform ceiling, over every campaign at once. This is the one that
	//    protects the AI provider's quota: each concurrent call is one live voice
	//    session, and twenty at once is throttling, which is money spent on calls
	//    that fail.
	const platformSlots = input.platformConcurrency - counts.platformInFlight;

	if (platformSlots <= 0) {
		return blocked(
			"platform_concurrency",
			`Platformada bir vaqtda ${input.platformConcurrency} ta chiquvchi qo'ng'iroq chegarasi to'lgan — navbat kutilmoqda.`
		);
	}

	return ready(Math.min(counts.dueReachable, campaignSlots, platformSlots));
}
