/**
 * The campaign form's bounds, defaults and diff.
 *
 * Every limit here has a twin: a zod rule in `campaigns.schemas.ts` and a CHECK
 * constraint on `call_campaigns`. The form enforces them first so a value the UI
 * accepted cannot come back as a 400 - and so the person setting a campaign up
 * reads the reason next to the field instead of in a toast.
 */
import type { Campaign, CampaignCreateBody, CampaignKind, CampaignUpdateBody } from "../types";

/** Nobody may be rung before this hour or after it, in the tenant's own zone. */
export const EARLIEST_CALL_TIME = "07:00";
export const LATEST_CALL_TIME = "22:00";

export const PURPOSE_MIN = 10;
export const PURPOSE_MAX = 400;
export const SCRIPT_MAX = 4000;
export const NAME_MIN = 3;
export const NAME_MAX = 150;

export const MAX_ATTEMPTS_RANGE = { min: 1, max: 10 } as const;
export const RETRY_DELAY_RANGE = { min: 5, max: 1440 } as const;
export const CONCURRENCY_RANGE = { min: 1, max: 20 } as const;

/**
 * Quarter-hour steps rather than a free text box.
 *
 * A typed "9:00" or "25:00" is a 400 from the server; a list cannot produce one.
 * The list is also clipped to the legal window, so the UI never offers an hour
 * the database would refuse.
 */
function buildTimeOptions(): { value: string; label: string }[] {
	const options: { value: string; label: string }[] = [];
	const [startHour] = EARLIEST_CALL_TIME.split(":").map(Number);
	const [endHour] = LATEST_CALL_TIME.split(":").map(Number);

	for (let hour = startHour ?? 7; hour <= (endHour ?? 22); hour += 1) {
		for (const minute of [0, 15, 30, 45]) {
			if (hour === endHour && minute > 0) {
				break;
			}

			const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
			options.push({ value, label: value });
		}
	}

	return options;
}

export const CALL_TIME_OPTIONS = buildTimeOptions();

export interface CampaignFormValues {
	name: string;
	kind: CampaignKind;
	purpose: string;
	script: string;
	agentProfileId: string | undefined;
	callWindowStart: string;
	callWindowEnd: string;
	maxAttempts: number;
	retryDelayMinutes: number;
	concurrency: number;
}

/** The column defaults, repeated so a new campaign opens with the same numbers. */
export const DEFAULT_FORM_VALUES: CampaignFormValues = {
	name: "",
	kind: "reminder",
	purpose: "",
	script: "",
	agentProfileId: undefined,
	callWindowStart: "09:00",
	callWindowEnd: "18:00",
	maxAttempts: 2,
	retryDelayMinutes: 60,
	concurrency: 1,
};

export function toFormValues(campaign: Campaign): CampaignFormValues {
	return {
		name: campaign.name,
		kind: campaign.kind,
		purpose: campaign.purpose,
		script: campaign.script ?? "",
		agentProfileId: campaign.agentProfileId ?? undefined,
		callWindowStart: campaign.callWindowStart,
		callWindowEnd: campaign.callWindowEnd,
		maxAttempts: campaign.maxAttempts,
		retryDelayMinutes: campaign.retryDelayMinutes,
		concurrency: campaign.concurrency,
	};
}

export function toCreateBody(values: CampaignFormValues): CampaignCreateBody {
	const script = values.script.trim();

	return {
		name: values.name.trim(),
		kind: values.kind,
		purpose: values.purpose.trim(),
		script: script.length > 0 ? script : undefined,
		agentProfileId: values.agentProfileId,
		callWindowStart: values.callWindowStart,
		callWindowEnd: values.callWindowEnd,
		maxAttempts: values.maxAttempts,
		retryDelayMinutes: values.retryDelayMinutes,
		concurrency: values.concurrency,
	};
}

/**
 * Only what changed.
 *
 * PATCH rejects an empty body, and sending every field back would rewrite the
 * purpose - the sentence a stranger is told - on every save, filling the audit
 * trail with "purpose changed" entries that changed nothing.
 */
export function toUpdateBody(
	baseline: CampaignFormValues,
	values: CampaignFormValues
): CampaignUpdateBody {
	const patch: CampaignUpdateBody = {};

	if (values.name.trim() !== baseline.name.trim()) {
		patch.name = values.name.trim();
	}

	if (values.kind !== baseline.kind) {
		patch.kind = values.kind;
	}

	if (values.purpose.trim() !== baseline.purpose.trim()) {
		patch.purpose = values.purpose.trim();
	}

	if (values.script.trim() !== baseline.script.trim()) {
		const script = values.script.trim();
		patch.script = script.length > 0 ? script : null;
	}

	if (values.agentProfileId !== baseline.agentProfileId) {
		patch.agentProfileId = values.agentProfileId ?? null;
	}

	if (values.callWindowStart !== baseline.callWindowStart) {
		patch.callWindowStart = values.callWindowStart;
	}

	if (values.callWindowEnd !== baseline.callWindowEnd) {
		patch.callWindowEnd = values.callWindowEnd;
	}

	if (values.maxAttempts !== baseline.maxAttempts) {
		patch.maxAttempts = values.maxAttempts;
	}

	if (values.retryDelayMinutes !== baseline.retryDelayMinutes) {
		patch.retryDelayMinutes = values.retryDelayMinutes;
	}

	if (values.concurrency !== baseline.concurrency) {
		patch.concurrency = values.concurrency;
	}

	return patch;
}

/** "60" -> "1 soat", so a retry delay reads as a wait and not as a number. */
export function formatMinutes(minutes: number): string {
	if (minutes < 60) {
		return `${minutes} daqiqa`;
	}

	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;

	return rest === 0 ? `${hours} soat` : `${hours} soat ${rest} daqiqa`;
}
