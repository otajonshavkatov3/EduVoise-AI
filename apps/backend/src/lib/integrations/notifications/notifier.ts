/**
 * Notification dispatch and the three triggers TZ 14.2 asks for.
 *
 * THE CONTRACT THAT MATTERS: nothing in this file throws.
 *
 * Two of the three triggers fire from a live call path (an AI session dying) or
 * from an operator's click (a failed appeal send). A notification is the least
 * important thing happening at that moment, so every entry point catches
 * everything and reports the outcome as data. A Telegram outage must never turn
 * into a dropped call or a 500 on a ticket send.
 *
 * De-duplication is in-memory and per-process. Restarting the backend can
 * therefore repeat one alert - which is the right trade against persisting alert
 * state in a table that would need a migration.
 */
import { createIntegrationLogger } from "../logging";
import { getNumberSetting, getStringSetting } from "../settings";
import { sendEmailNotification } from "./email";
import { sendTelegramMessage } from "./telegram";
import type {
	ChannelDeliveryResult,
	NotificationMessage,
	NotificationSeverity,
	NotifyResult,
} from "./types";

const logger = createIntegrationLogger("integrations:notifications");

export const NOTIFICATION_SETTING_KEYS = {
	dedupeMinutes: "notifications.dedupeMinutes",
	/** Shared with reports: the organisation timezone from the settings registry. */
	timezone: "general.timezone",
} as const;

const DEFAULT_DEDUPE_MINUTES = 30;
const DEFAULT_TIMEZONE = "Asia/Tashkent";

const SEVERITY_PREFIX: Record<NotificationSeverity, string> = {
	info: "MA'LUMOT",
	warning: "OGOHLANTIRISH",
	critical: "JIDDIY XATO",
};

/** dedupeKey -> epoch ms of the last delivery attempt. */
const lastDispatchedAt = new Map<string, number>();

function pruneDedupeCache(windowMs: number): void {
	const cutoff = Date.now() - windowMs;
	for (const [key, timestamp] of lastDispatchedAt) {
		if (timestamp < cutoff) {
			lastDispatchedAt.delete(key);
		}
	}
}

/** TZ 14.3: DD.MM.YYYY, 24-hour, local time. */
export async function formatAlertTimestamp(date: Date): Promise<string> {
	const timezone = (await getStringSetting(NOTIFICATION_SETTING_KEYS.timezone)) ?? DEFAULT_TIMEZONE;

	try {
		const parts = new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			day: "2-digit",
			month: "2-digit",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).formatToParts(date);

		const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
		return `${pick("day")}.${pick("month")}.${pick("year")} ${pick("hour")}:${pick("minute")}`;
	} catch {
		// An invalid timezone setting must not break an alert.
		return date.toISOString().replace("T", " ").slice(0, 16);
	}
}

function renderText(message: NotificationMessage, timestamp: string): string {
	return [
		`${SEVERITY_PREFIX[message.severity]}: ${message.title}`,
		"",
		...message.lines,
		"",
		`Vaqt: ${timestamp}`,
	].join("\n");
}

/**
 * Sends one message to every channel. Returns what each channel did.
 *
 * Channels are attempted in sequence rather than in parallel: there are two of
 * them, one of which never touches the network, and sequential keeps the log
 * readable.
 */
export async function dispatchNotification(message: NotificationMessage): Promise<NotifyResult> {
	try {
		const dedupeMinutes = await getNumberSetting(
			NOTIFICATION_SETTING_KEYS.dedupeMinutes,
			DEFAULT_DEDUPE_MINUTES
		);
		const windowMs = Math.max(dedupeMinutes, 0) * 60_000;
		const cacheKey = `${message.event}:${message.dedupeKey}`;

		pruneDedupeCache(windowMs);

		const previous = lastDispatchedAt.get(cacheKey);
		if (windowMs > 0 && previous !== undefined && Date.now() - previous < windowMs) {
			logger.debug(
				{ event: message.event, dedupeKey: message.dedupeKey },
				"notification suppressed as a duplicate"
			);
			return { event: message.event, delivered: false, deduped: true, channels: [] };
		}

		lastDispatchedAt.set(cacheKey, Date.now());

		const text = renderText(message, await formatAlertTimestamp(new Date()));
		const channels: ChannelDeliveryResult[] = [
			await sendTelegramMessage(text),
			await sendEmailNotification(message),
		];

		const delivered = channels.some((channel) => channel.delivered);

		logger.info(
			{
				event: message.event,
				delivered,
				channels: channels.map((channel) => `${channel.channel}:${channel.status}`),
			},
			"notification dispatched"
		);

		return { event: message.event, delivered, deduped: false, channels };
	} catch (cause) {
		// Belt and braces: the channels already swallow their own failures, so
		// reaching here means a settings read or the renderer failed. Still not
		// allowed to propagate.
		logger.error(
			{ event: message.event, err: cause instanceof Error ? cause.message : String(cause) },
			"notification dispatch failed"
		);
		return { event: message.event, delivered: false, deduped: false, channels: [] };
	}
}

// ===========================================
// Trigger 1 - AI session failure
// ===========================================

export interface AiSessionFailureAlert {
	sessionId: string;
	callId: string;
	provider: string;
	model: string | null;
	errorMessage: string | null;
	startedAt: Date | null;
}

export async function notifyAiSessionFailure(alert: AiSessionFailureAlert): Promise<NotifyResult> {
	const lines = [
		`Qo'ng'iroq ID: ${alert.callId}`,
		`Sessiya ID: ${alert.sessionId}`,
		`Provayder: ${alert.provider}${alert.model ? ` (${alert.model})` : ""}`,
		`Xato: ${alert.errorMessage ?? "sababi qayd etilmagan"}`,
	];

	if (alert.startedAt) {
		lines.push(`Boshlangan: ${await formatAlertTimestamp(alert.startedAt)}`);
	}

	return dispatchNotification({
		event: "ai_session_failed",
		severity: "critical",
		title: "AI sessiyasi xato bilan tugadi",
		lines,
		dedupeKey: alert.sessionId,
	});
}

// ===========================================
// Trigger 3 - no answered calls in business hours
// ===========================================

export interface NoAnsweredCallsAlert {
	windowMinutes: number;
	windowStart: Date;
	windowEnd: Date;
	/** Calls that started in the window, answered or not. */
	totalCalls: number;
}

export async function notifyNoAnsweredCalls(alert: NoAnsweredCallsAlert): Promise<NotifyResult> {
	const from = await formatAlertTimestamp(alert.windowStart);
	const to = await formatAlertTimestamp(alert.windowEnd);

	return dispatchNotification({
		event: "no_answered_calls",
		severity: "critical",
		title: `Ish vaqtida ${alert.windowMinutes} daqiqa davomida javob berilgan qo'ng'iroq yo'q`,
		lines: [
			`Oraliq: ${from} - ${to}`,
			`Kelgan qo'ng'iroqlar: ${alert.totalCalls}`,
			"Javob berilgan: 0",
			alert.totalCalls === 0
				? "Umuman qo'ng'iroq qayd etilmagan - telefoniya uzilgan bo'lishi mumkin."
				: "Qo'ng'iroqlar bor, lekin hech biri javobsiz qolgan - operatorlar holatini tekshiring.",
		],
		dedupeKey: "no-answered-calls",
	});
}

/** Test hook: clears the de-duplication cache. */
export function resetNotificationDedupeCache(): void {
	lastDispatchedAt.clear();
}
