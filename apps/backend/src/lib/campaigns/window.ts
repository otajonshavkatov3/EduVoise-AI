/**
 * The calling window: the rule that nobody gets rung at 03:00.
 *
 * A campaign carries a start and an end time of day as zero-padded HH:MM. They
 * are wall-clock times in the tenant's own zone, never instants - "call between
 * 09:00 and 18:00" means the customer's 09:00, not the server's. So the whole
 * evaluation is: ask what time it is in the tenant's zone, then compare two
 * strings. Zero-padded HH:MM sorts lexicographically, which is why the columns are
 * text and why there is no date arithmetic anywhere in this file.
 *
 * WHY THE ZONE RESOLVER IS DUPLICATED HERE
 *
 * routes/ai-costs has its own private copy that reads the same `general.timezone`
 * key with the same Asia/Tashkent fallback, so the two cannot disagree about what
 * zone a deployment is in. Unifying them would mean editing the finance page's
 * fold, which is out of scope for this change and carries no benefit beyond
 * tidiness - the shared thing is the setting key, and that is already shared.
 */
import type { TenantId } from "@shared/types";

import { getSetting } from "@/lib/settings";

/**
 * The zone used when `general.timezone` is unset or unknown to the runtime.
 * Identical to the fallback routes/ai-costs uses when bucketing days.
 */
export const FALLBACK_TIME_ZONE = "Asia/Tashkent";

/** The earliest and latest a campaign window may reach. Mirrored by a CHECK on the table. */
export const EARLIEST_CALL_TIME = "07:00";
export const LATEST_CALL_TIME = "22:00";

/** Zero-padded 24-hour HH:MM. The only accepted spelling, in the DB and over HTTP. */
export const HH_MM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface CallingWindow {
	/** Inclusive. HH:MM in the tenant's zone. */
	start: string;
	/** Exclusive, so an 18:00 end means the last dial starts at 17:59. */
	end: string;
}

export interface WindowState {
	timeZone: string;
	/** Wall clock in the tenant's zone right now, HH:MM. */
	now: string;
	openNow: boolean;
	/** Minutes until the window opens; 0 while it is open. */
	minutesUntilOpen: number;
	/** Uzbek, for the campaign page and for the reason a start is refused. */
	message: string;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * One formatter per zone rather than one per call.
 *
 * The dialer asks this on every tick, for every running campaign. Constructing an
 * Intl.DateTimeFormat is the expensive part; the map is bounded by the number of
 * zones a deployment configures, i.e. one.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	const cached = formatters.get(timeZone);

	if (cached !== undefined) {
		return cached;
	}

	const created = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	formatters.set(timeZone, created);

	return created;
}

/**
 * The tenant's zone, validated against the runtime.
 *
 * A zone the runtime does not know would otherwise throw once per lead on every
 * tick, so it is validated here and replaced by the fallback - a campaign must not
 * stop dialling because somebody typed a zone name wrong in Settings.
 */
export async function resolveTenantTimeZone(tenantId: TenantId): Promise<string> {
	const configured = await getSetting(tenantId, "general.timezone");

	if (configured.trim().length === 0) {
		return FALLBACK_TIME_ZONE;
	}

	try {
		formatter(configured).format(new Date());

		return configured;
	} catch {
		return FALLBACK_TIME_ZONE;
	}
}

/** What time it is in `timeZone`, as HH:MM. */
export function wallClock(timeZone: string, now: Date = new Date()): string {
	// en-GB + hour12:false yields "09:05"; "24:00" is possible at midnight in some
	// runtimes, and midnight is 00:00 for every comparison this file makes.
	const formatted = formatter(timeZone).format(now);

	return formatted === "24:00" ? "00:00" : formatted;
}

function toMinutes(hhmm: string): number {
	const [hours, minutes] = hhmm.split(":");

	return Number(hours) * 60 + Number(minutes);
}

/** Is `at` (HH:MM) inside the window? Start inclusive, end exclusive. */
export function isWithinWindow(window: CallingWindow, at: string): boolean {
	return at >= window.start && at < window.end;
}

/**
 * The whole window question answered in one object, including the sentence the UI
 * shows and the sentence a refused start uses - so the page and the error cannot
 * word the same fact two ways.
 */
export function describeWindow(
	window: CallingWindow,
	timeZone: string,
	now: Date = new Date()
): WindowState {
	const at = wallClock(timeZone, now);
	const openNow = isWithinWindow(window, at);

	if (openNow) {
		return {
			timeZone,
			now: at,
			openNow: true,
			minutesUntilOpen: 0,
			message: `Qo'ng'iroq vaqti ochiq (${window.start}–${window.end}, ${timeZone}).`,
		};
	}

	// Before the window today, or after it and therefore waiting for tomorrow. The
	// table's CHECK guarantees start < end, so there is no overnight case to handle.
	const nowMinutes = toMinutes(at);
	const startMinutes = toMinutes(window.start);
	const minutesUntilOpen =
		nowMinutes < startMinutes
			? startMinutes - nowMinutes
			: MINUTES_PER_DAY - nowMinutes + startMinutes;

	const hours = Math.floor(minutesUntilOpen / 60);
	const minutes = minutesUntilOpen % 60;
	const wait = hours > 0 ? `${hours} soat ${minutes} daqiqa` : `${minutes} daqiqa`;

	return {
		timeZone,
		now: at,
		openNow: false,
		minutesUntilOpen,
		message:
			`Hozir qo'ng'iroq vaqti emas — soat ${at} (${timeZone}), ruxsat etilgan vaqt ` +
			`${window.start}–${window.end}. Qo'ng'iroqlar ${wait}dan keyin boshlanadi.`,
	};
}
