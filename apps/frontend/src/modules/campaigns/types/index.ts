/**
 * The wire shapes of `/api/campaigns`.
 *
 * Mirrors `apps/backend/src/routes/campaigns/campaigns.schemas.ts` field for
 * field. The enum members are written the way they actually arrive - the
 * Postgres enum values are snake_case and the API does not translate them - so
 * every label map keyed by them needs the naming-convention exception that
 * `utils/labels.ts` carries.
 */

export type CampaignStatus = "draft" | "running" | "paused" | "finished" | "cancelled";

export type CampaignKind = "reminder" | "sales" | "promo" | "survey" | "other";

export type CampaignLeadStatus = "pending" | "calling" | "done" | "failed" | "skipped";

export type CampaignOutcome =
	| "answered"
	| "no_answer"
	| "busy"
	| "invalid_number"
	| "refused"
	| "agreed"
	| "callback_requested"
	| "wrong_person"
	| "do_not_call"
	| "failed";

export type DncSource = "asked_on_call" | "manual" | "import";

/** The three buttons the backend hands back in `availableActions`. */
export type CampaignAction = "start" | "pause" | "cancel";

export type ImportSkipReason =
	| "invalid_number"
	| "duplicate_in_file"
	| "already_in_campaign"
	| "do_not_call"
	| "insert_failed";

export interface PaginationMeta {
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

export interface Campaign {
	id: string;
	name: string;
	kind: CampaignKind;
	purpose: string;
	script: string | null;
	agentProfileId: string | null;
	agentProfileName: string | null;
	status: CampaignStatus;
	callWindowStart: string;
	callWindowEnd: string;
	maxAttempts: number;
	retryDelayMinutes: number;
	concurrency: number;
	createdBy: string | null;
	createdByName: string | null;
	startedBy: string | null;
	startedByName: string | null;
	startedAt: string | null;
	pausedAt: string | null;
	endedAt: string | null;
	createdAt: string;
	updatedAt: string;
	leadCount: number;
	pendingCount: number;
	availableActions: CampaignAction[];
}

export interface CampaignListFilters {
	status?: CampaignStatus;
	kind?: CampaignKind;
	q?: string;
	page: number;
	limit: number;
}

export interface CampaignCreateBody {
	name: string;
	kind?: CampaignKind;
	purpose: string;
	script?: string;
	agentProfileId?: string;
	callWindowStart?: string;
	callWindowEnd?: string;
	maxAttempts?: number;
	retryDelayMinutes?: number;
	concurrency?: number;
}

export interface CampaignUpdateBody {
	name?: string;
	kind?: CampaignKind;
	purpose?: string;
	script?: string | null;
	agentProfileId?: string | null;
	callWindowStart?: string;
	callWindowEnd?: string;
	maxAttempts?: number;
	retryDelayMinutes?: number;
	concurrency?: number;
}

export interface CampaignLead {
	id: string;
	campaignId: string;
	phoneNumber: string;
	phoneDisplay: string;
	fullName: string | null;
	contactId: string | null;
	variables: Record<string, string>;
	status: CampaignLeadStatus;
	outcome: CampaignOutcome | null;
	attempts: number;
	lastAttemptAt: string | null;
	nextAttemptAt: string | null;
	callId: string | null;
	note: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface LeadListFilters {
	status?: CampaignLeadStatus;
	outcome?: CampaignOutcome;
	q?: string;
	hasCall?: "true" | "false";
	page: number;
	limit: number;
}

export interface LeadUpdateBody {
	note?: string | null;
	outcome?: CampaignOutcome;
	action?: "requeue" | "skip";
}

/** One dial. A lead can be rung several times and each ring is its own `calls` row. */
export interface LeadAttempt {
	id: string;
	attemptNo: number;
	callId: string | null;
	outcome: CampaignOutcome | null;
	detail: string | null;
	dialedAt: string;
	endedAt: string | null;
	callDuration: number | null;
}

/** Can this deployment place the calls this campaign asks for? */
export interface DialingReadiness {
	trunkConfigured: boolean;
	hasExternalLeads: boolean;
	hasInternalLeads: boolean;
	canDial: boolean;
	/** O'zbekcha ogohlantirish; muammo bo'lmasa bo'sh satr. */
	warning: string;
}

export interface CampaignWindowState {
	start: string;
	end: string;
	timeZone: string;
	now: string;
	openNow: boolean;
	minutesUntilOpen: number;
	message: string;
}

export interface CampaignSpend {
	/** false — bu rol xarajatni ko'rmaydi (/ai-costs bilan bir xil qoida). */
	visible: boolean;
	sessions: number | null;
	pricedSessions: number | null;
	unpricedSessions: number | null;
	callSeconds: number | null;
	costUsd: number | null;
	costUzs: number | null;
	costPerAnsweredUsd: number | null;
}

export interface CampaignProgress {
	campaignId: string;
	status: CampaignStatus;
	leads: {
		total: number;
		pending: number;
		calling: number;
		done: number;
		failed: number;
		skipped: number;
		stalledCalling: number;
	};
	outcomes: Record<CampaignOutcome, number>;
	attempts: { total: number; withCall: number };
	spend: CampaignSpend;
	window: CampaignWindowState;
	dialing: DialingReadiness;
}

export interface ImportRowResult {
	index: number;
	line: number | null;
	status: "created" | "skipped" | "failed";
	input: string;
	phoneNumber: string | null;
	fullName: string | null;
	leadId: string | null;
	reason: ImportSkipReason | null;
	message: string | null;
}

export interface ImportResult {
	campaignId: string;
	submitted: number;
	created: number;
	skipped: number;
	failed: number;
	skippedByReason: Record<ImportSkipReason, number>;
	parsed: {
		delimiter: string;
		headers: string[] | null;
		ignoredLines: number[];
		truncated: boolean;
	} | null;
	results: ImportRowResult[];
}

export interface DncEntry {
	id: string;
	phoneNumber: string;
	phoneDisplay: string;
	reason: string | null;
	source: DncSource;
	sourceLabel: string;
	callId: string | null;
	createdBy: string | null;
	createdByName: string | null;
	/** false — odam qo'ng'iroq vaqtida o'zi so'ragan, o'chirilmaydi. */
	removable: boolean;
	createdAt: string;
}

export interface DncListFilters {
	q?: string;
	source?: DncSource;
	page: number;
	limit: number;
}

export interface DncRowResult {
	index: number;
	input: string;
	phoneNumber: string | null;
	status: "created" | "existing" | "failed";
	message: string | null;
	leadsSkipped: number;
}

export interface DncCreateResult {
	created: number;
	existing: number;
	failed: number;
	leadsSkipped: number;
	results: DncRowResult[];
}

export interface StartResult {
	campaign: Campaign;
	dialing: DialingReadiness;
	window: { openNow: boolean; message: string };
	warnings: string[];
}

// ===========================================
// Envelopes
// ===========================================

export interface ListEnvelope<T> {
	success: true;
	data: { items: T[]; meta: PaginationMeta };
}

export interface OneEnvelope<T> {
	success: true;
	data: T;
}

export interface LeadDetail {
	lead: CampaignLead;
	attempts: LeadAttempt[];
}
