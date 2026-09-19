/**
 * Watchdog that turns two database conditions into notifications (TZ 14.2).
 *
 * Why a poller and not a hook: the two conditions are "an AI session ended in
 * `failed`" and "no call was answered during business hours". The first is
 * written by the voice layer, the second is the *absence* of an event - and
 * nothing calls you when nothing happens. Polling the tables keeps this module
 * from having to reach into the call path at all, which is also what keeps the
 * "never throw into a call" rule easy to honour: the call path does not know
 * this file exists.
 *
 * Deliberate behaviours:
 *
 *   - the first tick is a BASELINE. Existing failed sessions are recorded as
 *     seen and nothing is sent, so a restart does not replay yesterday's
 *     failures as fresh alerts.
 *   - the answered-calls check requires the whole window to fall inside business
 *     hours, so a 09:05 tick does not alert about 08:05-09:05 when the office was
 *     shut.
 *   - "answered" is `status in (answered, completed) OR answered_at IS NOT NULL`.
 *     `answered_at` is a new column and is NULL for every historical row, so
 *     using it alone would report a busy call centre as silent.
 *   - ticks never overlap and never throw. A failure is logged and the next tick
 *     tries again.
 */
import { and, count, eq, gte, lte, sql } from "drizzle-orm";

import { db } from "@/db";
import { aiSessions, calls } from "@/db/schema";

import { createIntegrationLogger } from "../logging";
import {
	getBooleanSetting,
	getNumberArraySetting,
	getNumberSetting,
	getStringSetting,
} from "../settings";
import { notifyAiSessionFailure, notifyNoAnsweredCalls } from "./notifier";

const logger = createIntegrationLogger("integrations:notification-monitor");

export const MONITOR_SETTING_KEYS = {
	intervalMinutes: "notifications.monitor.intervalMinutes",
	/** Shared with reports: the organisation timezone from the settings registry. */
	timezone: "general.timezone",
	aiFailureEnabled: "notifications.alerts.aiSessionFailure.enabled",
	aiFailureLookbackMinutes: "notifications.alerts.aiSessionFailure.lookbackMinutes",
	noAnsweredEnabled: "notifications.alerts.noAnsweredCalls.enabled",
	noAnsweredWindowMinutes: "notifications.alerts.noAnsweredCalls.windowMinutes",
	businessHoursStart: "notifications.businessHours.start",
	businessHoursEnd: "notifications.businessHours.end",
	businessHoursDays: "notifications.businessHours.days",
} as const;

const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;
const DEFAULT_TIMEZONE = "Asia/Tashkent";
const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_BUSINESS_START = "09:00";
const DEFAULT_BUSINESS_END = "18:00";
/** Monday to Friday, ISO-style where Sunday is 0. */
const DEFAULT_BUSINESS_DAYS = [1, 2, 3, 4, 5];
/** Cap per tick so a provider outage that failed 200 sessions sends 5 alerts, not 200. */
const MAX_AI_ALERTS_PER_TICK = 5;

interface MonitorState {
	timer: ReturnType<typeof setInterval> | null;
	ticking: boolean;
	/** Session ids already alerted on (or baselined). Pruned by lookback. */
	seenFailedSessions: Map<string, number>;
	baselineDone: boolean;
	lastTickAt: Date | null;
	lastError: string | null;
}

/**
 * `bun --hot` re-evaluates modules, so module-level state would produce a second
 * interval on every save. Same globalThis trick the voice-platform bootstrap
 * uses in src/index.ts.
 */
const STATE_KEY = Symbol.for("callcenter.notificationMonitorState");
const globalStore = globalThis as unknown as Record<symbol, MonitorState | undefined>;

function getState(): MonitorState {
	let state = globalStore[STATE_KEY];
	if (!state) {
		state = {
			timer: null,
			ticking: false,
			seenFailedSessions: new Map(),
			baselineDone: false,
			lastTickAt: null,
			lastError: null,
		};
		globalStore[STATE_KEY] = state;
	}
	return state;
}

// ===========================================
// Business hours
// ===========================================

const WEEKDAY_INDEX: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

interface LocalMoment {
	/** Minutes since local midnight. */
	minuteOfDay: number;
	/** 0 = Sunday. */
	weekday: number;
}

/** Local wall-clock time in the configured timezone, or null if it is invalid. */
function toLocalMoment(date: Date, timezone: string): LocalMoment | null {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
			weekday: "short",
		}).formatToParts(date);

		const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
		const hour = Number(pick("hour"));
		const minute = Number(pick("minute"));
		const weekday = WEEKDAY_INDEX[pick("weekday")];

		if (!(Number.isFinite(hour) && Number.isFinite(minute)) || weekday === undefined) {
			return null;
		}

		// Intl renders midnight as 24 in some ICU versions with hour12:false.
		return { minuteOfDay: (hour % 24) * 60 + minute, weekday };
	} catch {
		return null;
	}
}

/** "HH:MM" -> minutes since midnight. Null when unparseable. */
function parseClock(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) {
		return null;
	}

	const hour = Number(match[1]);
	const minute = Number(match[2]);

	if (hour > 23 || minute > 59) {
		return null;
	}

	return hour * 60 + minute;
}

interface BusinessHours {
	startMinute: number;
	endMinute: number;
	days: number[];
	timezone: string;
}

async function resolveBusinessHours(): Promise<BusinessHours> {
	const timezone = (await getStringSetting(MONITOR_SETTING_KEYS.timezone)) ?? DEFAULT_TIMEZONE;
	const startRaw =
		(await getStringSetting(MONITOR_SETTING_KEYS.businessHoursStart)) ?? DEFAULT_BUSINESS_START;
	const endRaw =
		(await getStringSetting(MONITOR_SETTING_KEYS.businessHoursEnd)) ?? DEFAULT_BUSINESS_END;

	return {
		startMinute: parseClock(startRaw) ?? parseClock(DEFAULT_BUSINESS_START) ?? 540,
		endMinute: parseClock(endRaw) ?? parseClock(DEFAULT_BUSINESS_END) ?? 1080,
		days: await getNumberArraySetting(
			MONITOR_SETTING_KEYS.businessHoursDays,
			DEFAULT_BUSINESS_DAYS
		),
		timezone,
	};
}

function isWithinBusinessHours(date: Date, hours: BusinessHours): boolean {
	const moment = toLocalMoment(date, hours.timezone);
	if (!moment) {
		return false;
	}

	if (!hours.days.includes(moment.weekday)) {
		return false;
	}

	return moment.minuteOfDay >= hours.startMinute && moment.minuteOfDay <= hours.endMinute;
}

// ===========================================
// Check 1 - AI session failures
// ===========================================

function pruneSeen(state: MonitorState, lookbackMs: number): void {
	const cutoff = Date.now() - lookbackMs * 2;
	for (const [id, timestamp] of state.seenFailedSessions) {
		if (timestamp < cutoff) {
			state.seenFailedSessions.delete(id);
		}
	}
}

async function checkAiSessionFailures(state: MonitorState): Promise<void> {
	if (!(await getBooleanSetting(MONITOR_SETTING_KEYS.aiFailureEnabled, true))) {
		return;
	}

	const lookbackMinutes = await getNumberSetting(
		MONITOR_SETTING_KEYS.aiFailureLookbackMinutes,
		DEFAULT_LOOKBACK_MINUTES
	);
	const lookbackMs = Math.max(lookbackMinutes, 1) * 60_000;
	const since = new Date(Date.now() - lookbackMs);

	pruneSeen(state, lookbackMs);

	const rows = await db
		.select({
			id: aiSessions.id,
			callId: aiSessions.callId,
			provider: aiSessions.provider,
			model: aiSessions.model,
			errorMessage: aiSessions.errorMessage,
			startedAt: aiSessions.startedAt,
		})
		.from(aiSessions)
		.where(and(eq(aiSessions.status, "failed"), gte(aiSessions.startedAt, since)))
		.limit(100);

	const fresh = rows.filter((row) => !state.seenFailedSessions.has(row.id));

	// Baseline: remember what is already broken, alert on what breaks next.
	if (!state.baselineDone) {
		for (const row of rows) {
			state.seenFailedSessions.set(row.id, Date.now());
		}
		state.baselineDone = true;
		logger.info(
			{ baselinedFailures: rows.length },
			"notification monitor baseline recorded; alerts start from the next failure"
		);
		return;
	}

	for (const row of fresh.slice(0, MAX_AI_ALERTS_PER_TICK)) {
		state.seenFailedSessions.set(row.id, Date.now());
		await notifyAiSessionFailure({
			sessionId: row.id,
			callId: row.callId,
			provider: row.provider,
			model: row.model,
			errorMessage: row.errorMessage,
			startedAt: row.startedAt,
		});
	}

	if (fresh.length > MAX_AI_ALERTS_PER_TICK) {
		// Mark the overflow as seen: they are the same incident, and the alerts
		// already sent carry it. Logged so the real count is not lost.
		for (const row of fresh.slice(MAX_AI_ALERTS_PER_TICK)) {
			state.seenFailedSessions.set(row.id, Date.now());
		}
		logger.error(
			{ failedSessions: fresh.length, alerted: MAX_AI_ALERTS_PER_TICK },
			"more AI session failures than the per-tick alert cap; the rest were suppressed"
		);
	}
}

// ===========================================
// Check 2 - no answered calls in business hours
// ===========================================

async function checkNoAnsweredCalls(): Promise<void> {
	if (!(await getBooleanSetting(MONITOR_SETTING_KEYS.noAnsweredEnabled, true))) {
		return;
	}

	const windowMinutes = Math.max(
		await getNumberSetting(MONITOR_SETTING_KEYS.noAnsweredWindowMinutes, DEFAULT_WINDOW_MINUTES),
		5
	);
	const windowEnd = new Date();
	const windowStart = new Date(windowEnd.getTime() - windowMinutes * 60_000);
	const hours = await resolveBusinessHours();

	if (!(isWithinBusinessHours(windowStart, hours) && isWithinBusinessHours(windowEnd, hours))) {
		return;
	}

	const [row] = await db
		.select({
			total: count(),
			answered: sql<string>`count(*) filter (
				where ${calls.status} in ('answered', 'completed')
				or ${calls.answeredAt} is not null
			)`,
		})
		.from(calls)
		.where(and(gte(calls.startedAt, windowStart), lte(calls.startedAt, windowEnd)));

	const answered = Number(row?.answered ?? 0);

	if (answered > 0) {
		return;
	}

	await notifyNoAnsweredCalls({
		windowMinutes,
		windowStart,
		windowEnd,
		totalCalls: Number(row?.total ?? 0),
	});
}

// ===========================================
// Lifecycle
// ===========================================

/** Runs both checks once. Never throws; returns false if the tick failed. */
export async function runNotificationMonitorTick(): Promise<boolean> {
	const state = getState();

	if (state.ticking) {
		logger.debug("previous notification monitor tick is still running, skipping this one");
		return true;
	}

	state.ticking = true;
	state.lastTickAt = new Date();

	try {
		await checkAiSessionFailures(state);
		await checkNoAnsweredCalls();
		state.lastError = null;
		return true;
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		state.lastError = reason;
		logger.error({ err: reason }, "notification monitor tick failed");
		return false;
	} finally {
		state.ticking = false;
	}
}

/**
 * Starts the watchdog. Safe to call twice - the second call is a no-op.
 *
 * The interval is read once at start. Changing
 * `notifications.monitor.intervalMinutes` therefore takes effect on the next
 * restart, unlike every other setting here, which is read per tick.
 */
export async function startNotificationMonitor(): Promise<void> {
	const state = getState();

	if (state.timer) {
		return;
	}

	const intervalMinutes = Math.max(
		await getNumberSetting(MONITOR_SETTING_KEYS.intervalMinutes, DEFAULT_INTERVAL_MINUTES),
		MIN_INTERVAL_MINUTES
	);

	state.timer = setInterval(() => {
		// runNotificationMonitorTick swallows its own errors, so this catch only
		// exists so the interval callback can never produce an unhandled rejection.
		runNotificationMonitorTick().catch((cause: unknown) => {
			logger.error(
				{ err: cause instanceof Error ? cause.message : String(cause) },
				"notification monitor tick rejected unexpectedly"
			);
		});
	}, intervalMinutes * 60_000);

	logger.info({ intervalMinutes }, "notification monitor started");

	// Immediate first tick, which is the baseline pass.
	await runNotificationMonitorTick();
}

export function stopNotificationMonitor(): void {
	const state = getState();

	if (state.timer) {
		clearInterval(state.timer);
		state.timer = null;
		logger.info("notification monitor stopped");
	}
}

export function getNotificationMonitorStatus(): {
	running: boolean;
	baselineDone: boolean;
	lastTickAt: string | null;
	lastError: string | null;
	trackedFailures: number;
} {
	const state = getState();
	return {
		running: state.timer !== null,
		baselineDone: state.baselineDone,
		lastTickAt: state.lastTickAt?.toISOString() ?? null,
		lastError: state.lastError,
		trackedFailures: state.seenFailedSessions.size,
	};
}
