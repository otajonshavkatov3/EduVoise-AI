/**
 * Notifications (TZ 14.2).
 *
 *   telegram  the only channel that actually delivers. Bot token and chat id
 *             come from settings.
 *   email     a stub that reports "unsupported" rather than pretending: this
 *             backend has no SMTP transport and may not add a dependency.
 *   notifier  dispatch + de-duplication + the trigger functions.
 *   monitor   poller that raises both triggers (AI session failure, no answered
 *             calls in business hours) without touching the call path.
 */

export type { EmailSettings, RenderedEmail } from "./email";
export {
	EMAIL_SETTING_KEYS,
	getEmailChannelState,
	renderEmail,
	sendEmailNotification,
} from "./email";
export {
	getNotificationMonitorStatus,
	MONITOR_SETTING_KEYS,
	runNotificationMonitorTick,
	startNotificationMonitor,
	stopNotificationMonitor,
} from "./monitor";
export type { AiSessionFailureAlert, NoAnsweredCallsAlert } from "./notifier";
export {
	dispatchNotification,
	formatAlertTimestamp,
	NOTIFICATION_SETTING_KEYS,
	notifyAiSessionFailure,
	notifyNoAnsweredCalls,
	resetNotificationDedupeCache,
} from "./notifier";
export { getTelegramChannelState, sendTelegramMessage, TELEGRAM_SETTING_KEYS } from "./telegram";
export type {
	ChannelDeliveryResult,
	ChannelDeliveryStatus,
	ChannelState,
	NotificationChannel,
	NotificationEvent,
	NotificationMessage,
	NotificationSeverity,
	NotifyResult,
} from "./types";
