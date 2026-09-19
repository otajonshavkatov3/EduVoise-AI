/**
 * Outbound campaigns: the rules, without the HTTP.
 *
 *   import { checkDialAllowed, describeWindow } from "@/lib/campaigns";
 *
 * Everything a dial has to satisfy lives here rather than in the route handlers,
 * because the two callers are on opposite sides of the app: the campaign API
 * (routes/campaigns) and the dialer on the call path. Whichever of the two forgets
 * a rule is the one that rings somebody at 03:00 or re-dials a person who asked not
 * to be called, so there is one copy of each rule and both import it.
 *
 * The dial gate in particular - checkDialAllowed - must be called immediately
 * before every originate, not at import time and not at campaign start. See the
 * header of do-not-call.ts for why.
 *
 * dialer.ts is the third caller, and the one that actually rings people: it is
 * the loop that claims due leads, applies planCampaignTick (eligibility.ts) and
 * hands each dial to the telephony layer. Started once from src/index.ts.
 */
export {
	campaignDialerStatus,
	claimLeads,
	type DialerStatus,
	reclaimStaleClaims,
	registerCampaignDialerHooks,
	releaseInFlightClaims,
	runDialerTick,
	startCampaignDialer,
	stopCampaignDialer,
} from "./dialer";
export {
	type AddToDoNotCallInput,
	type AddToDoNotCallResult,
	ASKED_ON_CALL_REMOVAL_REFUSAL,
	addToDoNotCall,
	checkDialAllowed,
	type DialAllowed,
	type DialBlocked,
	type DialGate,
	findListedNumbers,
	isDoNotCall,
	isRemovableSource,
} from "./do-not-call";
export {
	type DialerBlockReason,
	planCampaignTick,
	type TickCounts,
	type TickInput,
	type TickPlan,
} from "./eligibility";
export {
	type RecordDialOutcomeInput,
	type RecordDialOutcomeResult,
	recordDialOutcome,
} from "./outcome";
export { buildLeadNote, outcomeLabel, toCampaignOutcome } from "./outcome-map";
export {
	type LeadDelimiter,
	type ParsedLeadRow,
	type ParsedLeadText,
	parseLeadText,
} from "./parse-leads";
export {
	formatPhone,
	isExtension,
	type NormalisedPhone,
	normalisePhone,
	type PhoneKind,
	type PhoneRejectReason,
} from "./phone";
export {
	FINAL_OUTCOMES,
	RETRYABLE_OUTCOMES,
	type RetryPlan,
	type RetryPlanInput,
	retryPlan,
} from "./retry";
export {
	assertTransition,
	availableActions,
	CAMPAIGN_ACTION_LABELS,
	CAMPAIGN_STATUS_LABELS,
	type CampaignAction,
	canTransition,
	describeRefusal,
	isEditable,
	targetStatus,
} from "./transitions";
export {
	type CallingWindow,
	describeWindow,
	EARLIEST_CALL_TIME,
	FALLBACK_TIME_ZONE,
	HH_MM_PATTERN,
	isWithinWindow,
	LATEST_CALL_TIME,
	resolveTenantTimeZone,
	type WindowState,
	wallClock,
} from "./window";
