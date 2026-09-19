/**
 * The active AI agent profile — who the agent is for THIS business.
 *
 * Read on every inbound call, so it is cached in-process and invalidated on
 * write. A call must never wait on a settings query, and a business that edits
 * its greeting expects the next caller to hear it, not a restart.
 */
import { eq } from "drizzle-orm";
import pino from "pino";
import pretty from "pino-pretty";

import { db } from "@/db";
import type { AiAgentProfileRecord, UnknownAnswerPolicy } from "@/db/schema";
import { aiAgentProfiles } from "@/db/schema";
import { getAiRuntimeConfig } from "@/lib/settings";
import { type TenantId, tenantWhere } from "@/lib/tenancy";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{ level: isProduction ? "info" : "debug" },
	isProduction ? undefined : pretty({ colorize: true })
).child({ module: "ai-agent:profile" });

/**
 * Sensible defaults for a business that has not configured anything yet.
 *
 * Deliberately generic and deliberately CAUTIOUS: with no knowledge base, the
 * agent must not improvise facts about a business it knows nothing about, so the
 * default unknown-policy is to hand the caller to a human.
 */
export const DEFAULT_PROFILE = {
	businessName: "Call Center",
	industry: null,
	businessDescription: null,
	language: "uz",
	additionalLanguages: ["ru"],
	voice: "alloy",
	greeting: null,
	recordingNotice: "Suhbat sifat nazorati uchun yozib olinadi.",
	customInstructions: null,
	ticketCategories: ["Umumiy savol", "Shikoyat", "Buyurtma", "Texnik yordam", "Boshqa"],
	unknownPolicy: "transfer" as UnknownAnswerPolicy,
	transferExtensions: ["101", "102", "103", "104"],
	businessHours: null,
	afterHoursMessage: null,
	maxCallSeconds: 900,
	silenceHangupMs: 20000,
} as const;

/** Shape the prompt builder and orchestrator consume. */
export interface ActiveAgentProfile {
	id: string | null;
	businessName: string;
	industry: string | null;
	businessDescription: string | null;
	language: string;
	additionalLanguages: string[];
	voice: string;
	greeting: string | null;
	recordingNotice: string | null;
	customInstructions: string | null;
	ticketCategories: string[];
	unknownPolicy: UnknownAnswerPolicy;
	transferExtensions: string[];
	businessHours: Record<string, unknown> | null;
	afterHoursMessage: string | null;
	maxCallSeconds: number;
	silenceHangupMs: number;
	/** False when no profile row exists yet and defaults are being used. */
	isConfigured: boolean;
}

/**
 * Cached PER TENANT. A single slot here would have been a direct leak of the most
 * sensitive thing in the product: the profile decides the agent's business name,
 * its greeting, its instructions and its transfer list, so one shared slot would
 * have the agent answering customer B's caller as customer A's business.
 */
const cached = new Map<TenantId, { value: ActiveAgentProfile; at: number }>();

/** Long enough to keep calls off the database, short enough that edits feel live. */
const CACHE_TTL_MS = 30_000;

/** Drop one tenant's cached profile, or every tenant's. */
export function invalidateAgentProfileCache(tenantId?: TenantId): void {
	if (tenantId) {
		cached.delete(tenantId);
		return;
	}

	cached.clear();
	logger.debug("agent profile cache invalidated");
}

function toActive(row: AiAgentProfileRecord): ActiveAgentProfile {
	return {
		id: row.id,
		businessName: row.businessName,
		industry: row.industry,
		businessDescription: row.businessDescription,
		language: row.language,
		additionalLanguages: row.additionalLanguages ?? [],
		voice: row.voice,
		greeting: row.greeting,
		recordingNotice: row.recordingNotice,
		customInstructions: row.customInstructions,
		// An empty array would leave the model with no category to choose, so fall
		// back to the generic set rather than emitting none.
		ticketCategories:
			row.ticketCategories && row.ticketCategories.length > 0
				? row.ticketCategories
				: [...DEFAULT_PROFILE.ticketCategories],
		unknownPolicy: (row.unknownPolicy as UnknownAnswerPolicy) ?? DEFAULT_PROFILE.unknownPolicy,
		transferExtensions:
			row.transferExtensions && row.transferExtensions.length > 0
				? row.transferExtensions
				: [...DEFAULT_PROFILE.transferExtensions],
		businessHours: row.businessHours ?? null,
		afterHoursMessage: row.afterHoursMessage,
		maxCallSeconds: row.maxCallSeconds,
		silenceHangupMs: row.silenceHangupMs,
		isConfigured: true,
	};
}

/**
 * The profile for a business that has no row yet.
 *
 * Four of these fields come from the AI settings rather than from the constants
 * above, because those four are what the orchestrator and the provider read off
 * the profile - always, configured or not. Taking them from the constants meant
 * the deployment's own language, voice and call limits were dead on this path:
 * a supervisor could change the voice, the endpoint reported success, and every
 * caller still heard the hardcoded "alloy". With no profile row the settings are
 * the only place those four can come from, so this is where they come from.
 *
 * getAiRuntimeConfig() is the synchronous snapshot, refreshed at the top of every
 * call before this is reached; see lib/settings/ai-config.ts. It is read for THIS
 * tenant: an unconfigured business still gets its own deployment's voice and
 * limits, never another customer's.
 */
function defaults(tenantId: TenantId): ActiveAgentProfile {
	const ai = getAiRuntimeConfig(tenantId);

	return {
		id: null,
		businessName: DEFAULT_PROFILE.businessName,
		industry: DEFAULT_PROFILE.industry,
		businessDescription: DEFAULT_PROFILE.businessDescription,
		language: ai.language,
		additionalLanguages: [...DEFAULT_PROFILE.additionalLanguages],
		voice: ai.provider === "gemini" ? ai.geminiVoice : ai.openaiVoice,
		greeting: DEFAULT_PROFILE.greeting,
		recordingNotice: DEFAULT_PROFILE.recordingNotice,
		customInstructions: DEFAULT_PROFILE.customInstructions,
		ticketCategories: [...DEFAULT_PROFILE.ticketCategories],
		unknownPolicy: DEFAULT_PROFILE.unknownPolicy,
		transferExtensions: [...DEFAULT_PROFILE.transferExtensions],
		businessHours: null,
		afterHoursMessage: null,
		maxCallSeconds: ai.maxCallSeconds,
		silenceHangupMs: ai.silenceHangupMs,
		isConfigured: false,
	};
}

/**
 * The profile currently answering calls.
 *
 * Never throws and never returns null: a database hiccup must not stop the phone
 * from being answered, so a failure falls back to the cautious defaults and logs.
 */
export async function getActiveAgentProfile(tenantId: TenantId): Promise<ActiveAgentProfile> {
	const now = Date.now();
	const hit = cached.get(tenantId);

	if (hit && now - hit.at < CACHE_TTL_MS) {
		return hit.value;
	}

	try {
		const row = await db.query.aiAgentProfiles.findFirst({
			where: tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.isActive, true)),
		});

		const value = row ? toActive(row) : defaults(tenantId);
		cached.set(tenantId, { value, at: now });

		if (!row) {
			logger.warn(
				"no active AI agent profile configured - using cautious defaults (agent will transfer unknown questions)"
			);
		}

		return value;
	} catch (err) {
		logger.error({ err }, "could not load the AI agent profile - using defaults for this call");
		return defaults(tenantId);
	}
}

/**
 * Creates the first profile if the business has none, so a fresh install has
 * something editable in the dashboard instead of an empty form.
 */
export async function ensureDefaultProfile(
	tenantId: TenantId,
	createdBy?: string
): Promise<AiAgentProfileRecord> {
	const existing = await db.query.aiAgentProfiles.findFirst({
		where: tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.isActive, true)),
	});

	if (existing) {
		return existing;
	}

	// The same four fields the unconfigured profile takes from the AI settings, so
	// the row a fresh install gets matches what the deployment is configured for
	// instead of resetting the voice and the limits to the code's constants.
	const seed = defaults(tenantId);

	const [row] = await db
		.insert(aiAgentProfiles)
		.values({
			tenantId,
			businessName: DEFAULT_PROFILE.businessName,
			language: seed.language,
			additionalLanguages: [...DEFAULT_PROFILE.additionalLanguages],
			voice: seed.voice,
			recordingNotice: DEFAULT_PROFILE.recordingNotice,
			ticketCategories: [...DEFAULT_PROFILE.ticketCategories],
			unknownPolicy: DEFAULT_PROFILE.unknownPolicy,
			transferExtensions: [...DEFAULT_PROFILE.transferExtensions],
			maxCallSeconds: seed.maxCallSeconds,
			silenceHangupMs: seed.silenceHangupMs,
			isActive: true,
			createdBy: createdBy ?? null,
		})
		.returning();

	invalidateAgentProfileCache(tenantId);

	if (!row) {
		throw new Error("failed to create the default AI agent profile");
	}

	logger.info({ id: row.id }, "created default AI agent profile");
	return row;
}

/**
 * Makes one profile the live one.
 *
 * Deactivate-then-activate inside a transaction, because the partial unique index
 * on is_active would otherwise reject the second row.
 */
export async function activateProfile(tenantId: TenantId, profileId: string): Promise<void> {
	await db.transaction(async (tx) => {
		// Both statements are tenant-scoped, and the first one especially: without it
		// activating a profile would deactivate every OTHER customer's live agent, and
		// their next caller would be answered by the cautious defaults.
		await tx
			.update(aiAgentProfiles)
			.set({ isActive: false, updatedAt: new Date() })
			.where(tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.isActive, true)));

		await tx
			.update(aiAgentProfiles)
			.set({ isActive: true, updatedAt: new Date() })
			.where(tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.id, profileId)));
	});

	invalidateAgentProfileCache(tenantId);
	logger.info({ profileId }, "activated AI agent profile");
}

/** True when the call falls inside configured business hours (or none are set). */
export function isWithinBusinessHours(profile: ActiveAgentProfile, at: Date = new Date()): boolean {
	const hours = profile.businessHours;

	if (!hours || typeof hours !== "object") {
		return true;
	}

	const days = (hours as { days?: Record<string, [string, string][]> }).days;

	if (!days) {
		return true;
	}

	const dayKey = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][at.getDay()];
	const ranges = dayKey ? days[dayKey] : undefined;

	// A configured day with no ranges means closed; an absent day means unconfigured,
	// and refusing calls because someone forgot to fill in Sunday would be worse
	// than answering, so absent falls through to open.
	if (!ranges) {
		return true;
	}
	if (ranges.length === 0) {
		return false;
	}

	const minutes = at.getHours() * 60 + at.getMinutes();

	return ranges.some(([from, to]) => {
		const [fh, fm] = from.split(":").map(Number);
		const [th, tm] = to.split(":").map(Number);
		if (
			fh === undefined ||
			fm === undefined ||
			th === undefined ||
			tm === undefined ||
			Number.isNaN(fh) ||
			Number.isNaN(fm) ||
			Number.isNaN(th) ||
			Number.isNaN(tm)
		) {
			return false;
		}
		return minutes >= fh * 60 + fm && minutes <= th * 60 + tm;
	});
}
