/**
 * Notification model (TZ 14.2).
 *
 * A notification is data, not a string: the channel decides how to render it.
 * That keeps Telegram's plain-text formatting out of the trigger sites and
 * makes an unrendered `lines` array the thing a future in-app channel consumes.
 *
 * Every result type carries a `status` rather than a bare boolean because
 * "nobody configured this channel" and "the channel rejected the message" have
 * to be distinguishable in the log and in the UI. `delivered: false` with
 * `status: "unconfigured"` is a normal, non-alarming outcome.
 */

export type NotificationEvent = "ai_session_failed" | "no_answered_calls";

export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationMessage {
	event: NotificationEvent;
	severity: NotificationSeverity;
	/** Uzbek, one line. */
	title: string;
	/** Uzbek "Label: value" lines. Rendered in order. */
	lines: string[];
	/**
	 * Identity for de-duplication. Two messages with the same event and key
	 * inside the de-dupe window produce one delivery.
	 */
	dedupeKey: string;
}

export type NotificationChannel = "telegram" | "email";

export type ChannelDeliveryStatus =
	/** Accepted by the channel. */
	| "sent"
	/** No credentials configured, or the channel is switched off. Not an error. */
	| "unconfigured"
	/** Configured, but this backend cannot deliver it (see email.ts). */
	| "unsupported"
	/** Configured and attempted, but the channel rejected it or was unreachable. */
	| "failed";

export interface ChannelDeliveryResult {
	channel: NotificationChannel;
	delivered: boolean;
	status: ChannelDeliveryStatus;
	/** Uzbek explanation, safe to show in a UI. Never contains a token. */
	message: string;
}

export interface NotifyResult {
	event: NotificationEvent;
	/** True when at least one channel accepted the message. */
	delivered: boolean;
	/** True when the message was suppressed as a duplicate. */
	deduped: boolean;
	channels: ChannelDeliveryResult[];
}

export interface ChannelState {
	configured: boolean;
	/** Uzbek explanation when not configured. */
	message: string;
	missingKeys: string[];
}
