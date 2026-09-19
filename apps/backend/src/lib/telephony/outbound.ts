/**
 * Outbound campaign calls: the dial string, the outcome vocabulary, and the two
 * seams the dialer plugs into.
 *
 * The orchestrator knows how to run a call. This module knows the three things
 * that are specific to a call the PLATFORM placed rather than answered:
 *
 *   resolveOutboundEndpoint   what to hand ARI as the endpoint to dial. It comes
 *                             from configuration ("PJSIP/{number}" today,
 *                             "PJSIP/{number}@trunk-<slug>" once a carrier is bought)
 *                             so the change is a setting, never a release.
 *   describeOutboundDialing   what the dashboard has to tell the owner BEFORE
 *                             they launch a campaign - above all, that with no
 *                             SIP trunk configured this deployment can only ring
 *                             internal extensions and every mobile number in
 *                             their list will fail.
 *   the dialer hooks          where an outcome goes, and where an opt-out goes.
 *                             The campaign tables are not owned here, so this
 *                             module owns the CONTRACT and nothing else.
 *
 * Deliberately not here: the calling window, attempt limits, per-campaign
 * concurrency and the do-not-call TABLE. Those belong to the dialer that owns the
 * campaign rows. What this module does insist on is that the guardrail cannot be
 * skipped by accident: placeOutboundCall() consults `isDoNotCall` itself before
 * every single dial, so a manual test call or a future one-off "ring this person"
 * button cannot ring somebody who has asked never to be rung again.
 */
import pino from "pino";
import pretty from "pino-pretty";
import type { OutboundCallOutcome } from "@/lib/ai/tools";
import { OUTBOUND_CALL_OUTCOMES } from "@/lib/ai/tools";
import { getAiRuntimeConfig } from "@/lib/settings";
import type { TenantId } from "@/lib/tenancy";
import type { OutboundCallPurpose, OutboundCampaignKind } from "./contracts";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "telephony:outbound",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

/** The placeholder the dial pattern setting substitutes the lead's digits into. */
export const DIAL_PATTERN_TOKEN = "{number}";

/**
 * Shortest and longest thing that can be dialled.
 *
 * Three digits, because an internal extension (101) is a perfectly good campaign
 * target and is how this feature is tested with no carrier attached. Twenty, which
 * is E.164's own ceiling - anything longer is a spreadsheet accident, not a phone
 * number.
 */
const MIN_DIALABLE_DIGITS = 3;
const MAX_DIALABLE_DIGITS = 20;

// ===========================================
// Campaign kinds
// ===========================================

const CAMPAIGN_KINDS: readonly OutboundCampaignKind[] = [
	"reminder",
	"sales",
	"advertising",
	"survey",
	"other",
];

/**
 * Aliases the campaign side may have stored.
 *
 * A campaign row is written by a dashboard, so the value that arrives here is
 * whatever that form sent - including a spelling this build has never heard of.
 * An unknown kind resolves to "other" rather than throwing, because the
 * alternative is a call that fails at dial time, which is a worse answer than a
 * call whose opening line is a little more generic than it could have been.
 */
const CAMPAIGN_KIND_ALIASES: Record<string, OutboundCampaignKind> = {
	reminder: "reminder",
	followup: "reminder",
	eslatma: "reminder",
	sales: "sales",
	sell: "sales",
	offer: "sales",
	savdo: "sales",
	sotish: "sales",
	taklif: "sales",
	advertising: "advertising",
	advert: "advertising",
	ad: "advertising",
	ads: "advertising",
	// The value the campaign_kind enum actually stores for an advertising call. It
	// was missing, so every promo campaign resolved to "other" and lost the
	// advertising rules - the ones that say to give the person a way out in the
	// first breath and to stop at the first sign it is unwelcome.
	promo: "advertising",
	promotion: "advertising",
	marketing: "advertising",
	reklama: "advertising",
	survey: "survey",
	poll: "survey",
	feedback: "survey",
	research: "survey",
	sorovnoma: "survey",
	"so'rovnoma": "survey",
	other: "other",
	boshqa: "other",
};

/**
 * Spaces, dashes and underscores are typing habits rather than different words,
 * so "follow-up", "follow_up" and "followup" all resolve to the same key.
 */
function campaignKindKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "");
}

/** The campaign kind for whatever the campaign row holds. Never throws. */
export function resolveOutboundCampaignKind(
	value: string | null | undefined
): OutboundCampaignKind {
	return CAMPAIGN_KIND_ALIASES[campaignKindKey(value ?? "")] ?? "other";
}

/** Every campaign kind, in the order a dashboard should offer them. */
export function listOutboundCampaignKinds(): readonly OutboundCampaignKind[] {
	return CAMPAIGN_KINDS;
}

// ===========================================
// Outcomes
// ===========================================

/**
 * Outcomes the CHANNEL decides, which the agent never gets to see.
 *
 * Kept apart from the conversation outcomes (OUTBOUND_CALL_OUTCOMES in
 * lib/ai/tools.ts) because they are produced by different things and mean
 * different things to a retry policy: "no_answer" and "busy" are worth trying
 * again in an hour, "invalid_number" never is, and "refused" - which only a
 * person can say - must never be retried at all.
 */
export const OUTBOUND_CHANNEL_OUTCOMES = ["no_answer", "busy", "invalid_number", "failed"] as const;

export type OutboundChannelOutcome = (typeof OUTBOUND_CHANNEL_OUTCOMES)[number];

/**
 * Every outcome one campaign call can end with.
 *
 * Exported as a list so the campaign side can validate its own column against
 * exactly these values instead of keeping a second copy that drifts.
 */
export const OUTBOUND_OUTCOMES = [...OUTBOUND_CALL_OUTCOMES, ...OUTBOUND_CHANNEL_OUTCOMES] as const;

export type OutboundOutcome = OutboundCallOutcome | OutboundChannelOutcome;

/** True when this outcome means the number must never be dialled again. */
export function isOptOutOutcome(outcome: OutboundOutcome): boolean {
	return outcome === "opt_out";
}

// ===========================================
// The dialer seams
// ===========================================

/** One lead's result, as the campaign side needs to store it. */
export interface OutboundOutcomeEvent {
	/** calls.id - the row the transcript, the recording and the cost hang off. */
	callId: string;
	campaignId: string | null;
	leadId: string | null;
	/** Digits, exactly as they were written to calls.caller_number. */
	phone: string;
	outcome: OutboundOutcome;
	/** Short, in Uzbek or the language of the call. Safe to show on a page. */
	reason: string | null;
	/** ISO-8601, only when the person named a time to be called back. */
	callBackAt: string | null;
	/**
	 * True when the person asked never to be called again.
	 *
	 * Redundant with `outcome === "opt_out"` on purpose: a dialer that stores the
	 * outcome as a string and forgets to special-case one value still has an
	 * unmissable boolean to key the do-not-call write off.
	 */
	optOut: boolean;
	/** Who decided: the person's own words, or the channel result. */
	source: "conversation" | "channel";
	/** Whole seconds from dial to teardown, when the call got that far. */
	durationSeconds: number | null;
	at: string;
}

/** What the platform hands over when somebody asks not to be called again. */
export interface OutboundOptOutEntry {
	/** Whose list to add it to. */
	tenantId: TenantId;
	/** Digits. The do-not-call check is by number, not by contact or by lead. */
	phone: string;
	reason: string | null;
	callId: string;
	campaignId: string | null;
	leadId: string | null;
	at: string;
}

/**
 * What the campaign side has to provide.
 *
 * All three are optional so the telephony layer works with nothing registered -
 * that is how an internal test call is placed and how the whole suite runs - but
 * they are not equally optional in production:
 *
 *   isDoNotCall     SHOULD exist. Without it this layer cannot enforce the
 *                   do-not-call list itself and has to trust that the caller
 *                   already checked. It logs a warning once per process so the
 *                   omission is visible rather than assumed.
 *   recordOutcome   MUST exist, or the business learns nothing from its calls.
 *   addToDoNotCall  MUST exist. This is the one that makes "don't call me again"
 *                   true. Without it the opt-out is still recorded on the call
 *                   (a note plus a system transcript line) and reported through
 *                   recordOutcome with optOut: true, and the failure is logged at
 *                   error level - but nothing stops the next campaign.
 */
export interface OutboundDialerHooks {
	recordOutcome?(event: OutboundOutcomeEvent): Promise<void> | void;
	/** Per tenant: the do-not-call list belongs to one customer, not to the platform. */
	isDoNotCall?(tenantId: TenantId, phone: string): Promise<boolean> | boolean;
	addToDoNotCall?(entry: OutboundOptOutEntry): Promise<void> | void;
}

/**
 * Kept on globalThis rather than in a module-level `let`.
 *
 * The backend runs with `bun --hot`, which re-evaluates a module on save. A
 * plain module variable would silently lose the dialer's registration mid-shift
 * and the do-not-call check would start passing everything.
 */
const HOOKS_KEY = Symbol.for("callcenter.telephony.outboundDialerHooks");

interface HooksSlot {
	hooks: OutboundDialerHooks;
	/** So the "nobody is enforcing the do-not-call list" warning is logged once. */
	warnedAboutDoNotCall: boolean;
}

const globalStore = globalThis as unknown as Record<symbol, HooksSlot | undefined>;

function slot(): HooksSlot {
	const existing = globalStore[HOOKS_KEY];

	if (existing !== undefined) {
		return existing;
	}

	const created: HooksSlot = { hooks: {}, warnedAboutDoNotCall: false };
	globalStore[HOOKS_KEY] = created;

	return created;
}

/**
 * Register the campaign side's implementations. Call it once, at boot.
 *
 * Passing null clears them, which is what a test does between cases.
 */
export function setOutboundDialerHooks(hooks: OutboundDialerHooks | null): void {
	slot().hooks = hooks ?? {};
	slot().warnedAboutDoNotCall = false;

	logger.info(
		{
			recordOutcome: hooks?.recordOutcome !== undefined,
			isDoNotCall: hooks?.isDoNotCall !== undefined,
			addToDoNotCall: hooks?.addToDoNotCall !== undefined,
		},
		"outbound dialer hooks registered"
	);
}

export function getOutboundDialerHooks(): OutboundDialerHooks {
	return slot().hooks;
}

/**
 * Hand one lead's result to the campaign side.
 *
 * Never throws. A dialer whose own write fails must not also take down the call
 * teardown that was reporting to it - the call is over either way, and the log
 * line is what tells the owner why a campaign row looks unfinished.
 */
export async function reportOutboundOutcome(event: OutboundOutcomeEvent): Promise<void> {
	const hooks = getOutboundDialerHooks();

	if (hooks.recordOutcome === undefined) {
		logger.warn(
			{ callId: event.callId, outcome: event.outcome },
			"no outcome sink is registered (setOutboundDialerHooks), so this result is only on the call row"
		);
		return;
	}

	try {
		await hooks.recordOutcome(event);
	} catch (cause) {
		logger.error(
			{ err: cause, callId: event.callId, outcome: event.outcome },
			"the campaign side failed to record this outcome"
		);
	}
}

/**
 * Put a number on the do-not-call list.
 *
 * Resolves to whether it actually landed, because this is the one promise the
 * feature makes and the caller has to be able to say so in the transcript rather
 * than claim it. Logged at ERROR when it did not: an opt-out that was taken from
 * a person and then dropped is the most serious failure this code has.
 */
export async function reportOutboundOptOut(entry: OutboundOptOutEntry): Promise<boolean> {
	const hooks = getOutboundDialerHooks();

	if (hooks.addToDoNotCall === undefined) {
		logger.error(
			{ callId: entry.callId, phone: entry.phone },
			"somebody asked never to be called again but no do-not-call sink is registered (setOutboundDialerHooks); the request is only on the call row"
		);
		return false;
	}

	try {
		await hooks.addToDoNotCall(entry);
		logger.info(
			{ callId: entry.callId, phone: entry.phone },
			"number added to the do-not-call list"
		);
		return true;
	} catch (cause) {
		logger.error(
			{ err: cause, callId: entry.callId, phone: entry.phone },
			"writing the do-not-call entry failed; this number can still be dialled"
		);
		return false;
	}
}

// ===========================================
// What the dialer asks for
// ===========================================

/**
 * One dial, as the campaign side asks for it.
 *
 * Deliberately says nothing about ARI, channels, Stasis or the dialplan: that is
 * the whole point of the seam. The dialer decides WHO to ring and WHEN (the
 * calling window, the attempt limit, the concurrency budget are all its own);
 * this layer decides HOW a ring becomes an AI conversation.
 */
export interface OutboundCallRequest {
	/** The number to ring, in any format the list held it in. */
	number: string;
	/**
	 * Whose campaign this is. Decides the dial pattern (hence the trunk), the caller
	 * id presented and the agent that speaks - none of which may come from another
	 * customer's settings.
	 */
	tenantId: TenantId;
	/** Why. Injected into the prompt and spoken in the opening line. */
	purpose: OutboundCallPurpose;
	/** For the outcome event, so the dialer can find its own row again. */
	campaignId?: string | null;
	leadId?: string | null;
	/**
	 * Who pressed start, for the audit trail.
	 *
	 * Written onto the call as a note, so "who rang this person, and on whose
	 * authority" is answerable from the /calls/:id card months later, without
	 * joining anything.
	 */
	requestedByUserId?: string | null;
	/** Overrides ai.outbound.ringTimeoutSeconds for this one dial. */
	ringTimeoutSeconds?: number;
}

/** Why a dial was refused before Asterisk was ever asked to ring anybody. */
export type OutboundDialRefusal =
	| "invalid_number"
	| "do_not_call"
	| "not_running"
	| "originate_failed";

/** The dial is in flight. The channel exists; nobody has picked up yet. */
export interface OutboundCallPlaced {
	placed: true;
	/** calls.id - already written, with direction "outbound". */
	callId: string;
	channelId: string;
	/** What was handed to ARI, e.g. "PJSIP/101". For the log and the audit note. */
	endpoint: string;
	/** The digits, as written to calls.caller_number. */
	phone: string;
}

/**
 * No call was placed.
 *
 * `outcome` is filled in when the refusal is itself a result the dialer should
 * store against the lead (an unusable number, a number on the list). It is null
 * when the refusal says nothing about the lead - the orchestrator being down is
 * our problem, and filing it against the person would burn one of their attempts
 * for something they did not do.
 */
export interface OutboundCallRefused {
	placed: false;
	refusal: OutboundDialRefusal;
	/** Uzbek, safe to render on the campaign page. */
	message: string;
	outcome: OutboundOutcome | null;
	/** Set only when a call row had already been written before the refusal. */
	callId: string | null;
}

export type PlaceOutboundCallResult = OutboundCallPlaced | OutboundCallRefused;

/**
 * Is this number on the do-not-call list?
 *
 * Fails CLOSED: a hook that throws is treated as "do not dial". A campaign that
 * stops because the check is broken costs the owner a delay; a campaign that
 * dials through a broken check costs them the one promise this feature makes.
 */
export async function isDoNotCallNumber(tenantId: TenantId, phone: string): Promise<boolean> {
	const hooks = getOutboundDialerHooks();

	if (hooks.isDoNotCall === undefined) {
		const state = slot();

		if (!state.warnedAboutDoNotCall) {
			state.warnedAboutDoNotCall = true;
			logger.warn(
				"no do-not-call check is registered (setOutboundDialerHooks), so this layer cannot enforce the list itself"
			);
		}

		return false;
	}

	try {
		return await hooks.isDoNotCall(tenantId, phone);
	} catch (cause) {
		logger.error(
			{ err: cause, phone },
			"the do-not-call check threw; refusing to dial this number"
		);
		return true;
	}
}

// ===========================================
// The dial string
// ===========================================

/** Digits only, which is what both Asterisk and calls.caller_number want. */
export function toDialableDigits(number: string): string {
	return number.replace(/\D/g, "");
}

export interface OutboundEndpointResult {
	/** What to hand ARI as `endpoint`, e.g. "PJSIP/101". */
	endpoint: string;
	/** The digits that went into it - also what the call row records. */
	digits: string;
}

/**
 * Turn a number from the list into the endpoint ARI should dial.
 *
 * The pattern is configuration, so this is the whole of what changes when a
 * carrier is connected. Returns null for a number that is not dialable at all,
 * which the caller reports as an invalid number rather than sending Asterisk a
 * dial string it will reject.
 */
export function resolveOutboundEndpoint(
	number: string,
	// Required rather than defaulted from the settings snapshot: the pattern is a
	// TENANT's dial pattern now (it names their trunk), and a default that read it
	// from a process-wide snapshot would dial one customer's number over another
	// customer's carrier. Every caller already had it to hand.
	pattern: string
): OutboundEndpointResult | null {
	const digits = toDialableDigits(number);

	if (digits.length < MIN_DIALABLE_DIGITS || digits.length > MAX_DIALABLE_DIGITS) {
		return null;
	}

	const template = pattern.trim();

	if (!template.includes(DIAL_PATTERN_TOKEN)) {
		// The registry schema refuses a pattern with no token, so this only happens
		// with a hand-written override. Refusing here is what stops every lead in a
		// list being dialled at the same endpoint.
		logger.error(
			{ pattern: template },
			`the outbound dial pattern has no ${DIAL_PATTERN_TOKEN} in it, so no number can be dialled`
		);
		return null;
	}

	return { endpoint: template.split(DIAL_PATTERN_TOKEN).join(digits), digits };
}

/**
 * The trunk endpoint a dial pattern points at, or null when it points at a local
 * PJSIP endpoint.
 *
 * "PJSIP/{number}@trunk-avilab" -> "trunk-avilab". Asterisk reads everything after the "@" as
 * the endpoint to send the call through, which is exactly the difference between
 * ringing extension 101 in this container and ringing a mobile phone through a
 * carrier.
 */
export function trunkFromDialPattern(pattern: string): string | null {
	const at = pattern.lastIndexOf("@");

	if (at < 0) {
		return null;
	}

	const endpoint = pattern.slice(at + 1).trim();

	return endpoint.length === 0 ? null : endpoint;
}

/**
 * Whether Asterisk has a carrier at all.
 *
 * Read straight from process.env and NOT through getServerEnv(): SIP_TRUNK_* is
 * consumed by the Asterisk container's entrypoint, not by the backend, and adding
 * it to the validated server schema would advertise that this process uses it.
 * All the backend needs is the one bit of knowledge the owner needs too - has a
 * trunk been configured, yes or no.
 */
export function isTrunkConfigured(): boolean {
	return (process.env.SIP_TRUNK_HOST ?? "").trim().length > 0;
}

export interface OutboundDialingDescription {
	pattern: string;
	/** Caller id that will be presented, or null for "Asterisk decides". */
	callerId: string | null;
	trunkConfigured: boolean;
	/** The trunk the pattern routes through, when it routes through one. */
	trunkEndpoint: string | null;
	/** True when only internal extensions can be reached today. */
	internalOnly: boolean;
	ringTimeoutSeconds: number;
	maxConcurrentCalls: number;
	/**
	 * Uzbek, ready to render above a campaign's launch button. Null when there is
	 * nothing to warn about.
	 *
	 * This exists because the alternative is worse than an ugly banner: an owner
	 * imports four hundred mobile numbers, presses start, and every single row
	 * fails with a SIP error they cannot read.
	 */
	warning: string | null;
}

/** What the campaign page must tell the owner before they launch anything. */
export function describeOutboundDialing(tenantId: TenantId): OutboundDialingDescription {
	const config = getAiRuntimeConfig(tenantId).outbound;
	const pattern = config.dialPattern;
	const trunkEndpoint = trunkFromDialPattern(pattern);
	const trunkConfigured = isTrunkConfigured();
	const callerId = config.callerId.trim();

	let warning: string | null = null;

	if (!trunkConfigured) {
		warning =
			trunkEndpoint === null
				? "SIP trunk ulanmagan: hozir faqat ichki raqamlarga (masalan 101 yoki 201) qo'ng'iroq " +
					"qilish mumkin. Mobil raqamlarga qo'ng'iroq qilish uchun .env dagi SIP_TRUNK_HOST, " +
					"SIP_TRUNK_USERNAME va SIP_TRUNK_PASSWORD ni to'ldirib Asterisk'ni qayta ishga tushiring."
				: `Raqam shabloni «${trunkEndpoint}» trunk'i orqali qo'ng'iroq qilishga sozlangan, lekin ` +
					"SIP trunk ulanmagan (.env dagi SIP_TRUNK_HOST bo'sh) — har bir qo'ng'iroq xatoga uchraydi.";
	} else if (trunkEndpoint === null) {
		warning =
			"SIP trunk ulangan, lekin raqam shabloni uni ishlatmaydi: shu holda qo'ng'iroqlar faqat " +
			`ichki raqamlarga ketadi. Tashqi raqamlar uchun shablonni «PJSIP/${DIAL_PATTERN_TOKEN}@trunk-<slug>» ` +
			"ko'rinishida yozing.";
	}

	return {
		pattern,
		callerId: callerId.length === 0 ? null : callerId,
		trunkConfigured,
		trunkEndpoint,
		internalOnly: !trunkConfigured,
		ringTimeoutSeconds: config.ringTimeoutSeconds,
		maxConcurrentCalls: config.maxConcurrentCalls,
		warning,
	};
}

// ===========================================
// Hangup causes
// ===========================================

/**
 * What a Q.850 cause code means for a campaign row.
 *
 * These are the codes Asterisk reports on ChannelDestroyed for a call that never
 * reached our application, which is the only evidence there is about a phone
 * nobody picked up. The mapping matters because it decides whether the dialer
 * tries again: a busy line is worth another attempt this afternoon, an
 * unallocated number never is.
 *
 * A rejected call (21) is deliberately reported as a no-answer rather than as a
 * refusal. "Refused" in this vocabulary means a person said no in words; somebody
 * pressing the red button has told us nothing except that they were not
 * available, and filing it as a refusal would both overstate what we know and
 * hide it from the retry policy.
 */
const CAUSE_OUTCOMES: Record<number, { outcome: OutboundChannelOutcome; reason: string }> = {
	// AST_CAUSE_NOTDEFINED, and the one that MEASUREMENT put here rather than the
	// Q.850 table. Asterisk reports cause 0 when an originate reaches its own ring
	// timeout without the far end ever stating a reason - which is what a phone
	// nobody picks up looks like on this deployment (verified against PJSIP/101
	// with an 8 s timeout). It is safe to read as a no-answer because a dial that
	// genuinely broke never gets here: ARI rejects it at originate time and that
	// path is classified separately, as a failure.
	0: { outcome: "no_answer", reason: "Go'shak ko'tarilmadi" },
	1: { outcome: "invalid_number", reason: "Raqam mavjud emas" },
	2: { outcome: "invalid_number", reason: "Raqamga yo'l topilmadi" },
	3: { outcome: "invalid_number", reason: "Raqamga yo'l topilmadi" },
	16: { outcome: "no_answer", reason: "Go'shak ko'tarilmadi" },
	17: { outcome: "busy", reason: "Liniya band" },
	18: { outcome: "no_answer", reason: "Javob bo'lmadi" },
	19: { outcome: "no_answer", reason: "Go'shak ko'tarilmadi" },
	20: { outcome: "no_answer", reason: "Abonent o'chirilgan yoki tarmoqda emas" },
	21: { outcome: "no_answer", reason: "Qo'ng'iroq rad etildi" },
	22: { outcome: "invalid_number", reason: "Raqam o'zgargan" },
	27: { outcome: "failed", reason: "Manzilga ulanib bo'lmadi" },
	28: { outcome: "invalid_number", reason: "Raqam formati noto'g'ri" },
	34: { outcome: "failed", reason: "Bo'sh kanal yo'q (trunk band)" },
	38: { outcome: "failed", reason: "Tarmoqda nosozlik" },
	41: { outcome: "failed", reason: "Vaqtinchalik nosozlik" },
	42: { outcome: "failed", reason: "Kommutatorda navbat to'lgan" },
	44: { outcome: "failed", reason: "So'ralgan kanal bo'sh emas" },
	58: { outcome: "failed", reason: "Kerakli imkoniyat mavjud emas" },
	88: { outcome: "invalid_number", reason: "Mos kelmaydigan manzil" },
};

export interface ChannelOutcomeVerdict {
	outcome: OutboundChannelOutcome;
	/** Uzbek, for the campaign page. Carries the raw cause for a support call. */
	reason: string;
}

/** Read a hangup cause as a campaign outcome. Unknown codes are retryable failures. */
export function classifyHangupCause(
	cause: number,
	causeText?: string | null
): ChannelOutcomeVerdict {
	const known = CAUSE_OUTCOMES[cause];
	const detail = (causeText ?? "").trim();
	const suffix = detail.length === 0 ? `cause ${cause}` : `cause ${cause}: ${detail}`;

	if (known === undefined) {
		return { outcome: "failed", reason: `Qo'ng'iroq amalga oshmadi (${suffix})` };
	}

	return { outcome: known.outcome, reason: `${known.reason} (${suffix})` };
}
