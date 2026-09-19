/**
 * E-mail notification channel - a stub, and it says so.
 *
 * READ THIS BEFORE ASSUMING E-MAIL ALERTS WORK. THEY DO NOT.
 *
 * There is no SMTP client in this backend: the dependency list is fixed (no new
 * npm packages), Bun ships no SMTP transport, and hand-rolling ESMTP over a raw
 * socket - with STARTTLS, AUTH and MIME encoding - is not something to smuggle
 * into an integration module.
 *
 * So this channel never claims a delivery:
 *
 *   - settings missing -> `status: "unconfigured"`, the normal quiet outcome.
 *   - settings present -> `status: "unsupported"` with an explicit message
 *     saying the SMTP transport is absent and the mail was NOT sent. Configuring
 *     SMTP here must not create the illusion that alerts are going out.
 *
 * `renderEmail` is real, so the day a transport is approved the only new code is
 * the socket work: subject, body and recipients are already assembled here.
 */
import { createIntegrationLogger } from "../logging";
import { getBooleanSetting, getNumberSetting, getStringSetting } from "../settings";
import type { ChannelDeliveryResult, ChannelState, NotificationMessage } from "./types";

const logger = createIntegrationLogger("integrations:email");

export const EMAIL_SETTING_KEYS = {
	/** Master switch for all notifications, shared with the Telegram channel. */
	enabled: "notifications.enabled",
	smtpHost: "notifications.email.host",
	smtpPort: "notifications.email.port",
	smtpSecure: "notifications.email.secure",
	smtpUser: "notifications.email.username",
	smtpPassword: "notifications.email.password",
	from: "notifications.email.fromAddress",
	to: "notifications.email.toAddresses",
} as const;

const DEFAULT_SMTP_PORT = 587;

export interface EmailSettings {
	smtpHost: string;
	smtpPort: number;
	/** SSL/TLS on connect (port 465) rather than STARTTLS (port 587). */
	smtpSecure: boolean;
	smtpUser: string | null;
	from: string;
	/** One or more recipients, comma-separated in the setting. */
	to: string[];
}

export interface RenderedEmail {
	subject: string;
	body: string;
	to: string[];
	from: string;
}

/** Subject + plain-text body. Ready for a transport that does not exist yet. */
export function renderEmail(message: NotificationMessage, settings: EmailSettings): RenderedEmail {
	return {
		subject: `[CallCenter] ${message.title}`,
		body: [message.title, "", ...message.lines].join("\n"),
		to: settings.to,
		from: settings.from,
	};
}

async function resolveEmailSettings(): Promise<EmailSettings | ChannelState> {
	const enabled = await getBooleanSetting(EMAIL_SETTING_KEYS.enabled, false);

	if (!enabled) {
		return {
			configured: false,
			message:
				"Bildirishnomalar o'chirilgan (notifications.enabled). Diqqat: backendda " +
				"SMTP transporti mavjud emas, yoqilganda ham email xat yuborilmaydi.",
			missingKeys: [EMAIL_SETTING_KEYS.enabled],
		};
	}

	const smtpHost = await getStringSetting(EMAIL_SETTING_KEYS.smtpHost);
	const from = await getStringSetting(EMAIL_SETTING_KEYS.from);
	const rawTo = await getStringSetting(EMAIL_SETTING_KEYS.to);
	const missingKeys: string[] = [];

	if (!smtpHost) {
		missingKeys.push(EMAIL_SETTING_KEYS.smtpHost);
	}
	if (!from) {
		missingKeys.push(EMAIL_SETTING_KEYS.from);
	}
	if (!rawTo) {
		missingKeys.push(EMAIL_SETTING_KEYS.to);
	}

	if (!(smtpHost && from && rawTo)) {
		return {
			configured: false,
			message: `Email sozlanmagan. Yetishmayotgan sozlamalar: ${missingKeys.join(", ")}.`,
			missingKeys,
		};
	}

	const to = rawTo
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (to.length === 0) {
		return {
			configured: false,
			message: `Email qabul qiluvchilari ko'rsatilmagan (${EMAIL_SETTING_KEYS.to}).`,
			missingKeys: [EMAIL_SETTING_KEYS.to],
		};
	}

	return {
		smtpHost,
		smtpPort: await getNumberSetting(EMAIL_SETTING_KEYS.smtpPort, DEFAULT_SMTP_PORT),
		smtpSecure: await getBooleanSetting(EMAIL_SETTING_KEYS.smtpSecure, false),
		smtpUser: await getStringSetting(EMAIL_SETTING_KEYS.smtpUser),
		from,
		to,
	};
}

function isChannelState(value: EmailSettings | ChannelState): value is ChannelState {
	return "configured" in value;
}

/**
 * Reports the channel as unconfigured even when SMTP settings exist, because
 * "configured" here would mean "can deliver", and it cannot.
 */
export async function getEmailChannelState(): Promise<ChannelState> {
	try {
		const resolved = await resolveEmailSettings();

		if (isChannelState(resolved)) {
			return resolved;
		}

		return {
			configured: false,
			message:
				`SMTP sozlamalari kiritilgan (${resolved.smtpHost}:${resolved.smtpPort}), lekin ` +
				"backendda SMTP transporti yo'q - email xabarnomalari YUBORILMAYDI. " +
				"Telegram kanalidan foydalaning.",
			missingKeys: [],
		};
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		return {
			configured: false,
			message: `Email sozlamalarini o'qish imkoni bo'lmadi: ${reason}`,
			missingKeys: [],
		};
	}
}

/**
 * Always returns `delivered: false`. Never throws.
 *
 * When SMTP settings exist the rendered subject and recipient list are logged at
 * warn level, so an operator can at least see in the log what would have been
 * sent - and can see, unambiguously, that it was not.
 */
export async function sendEmailNotification(
	message: NotificationMessage
): Promise<ChannelDeliveryResult> {
	let resolved: EmailSettings | ChannelState;

	try {
		resolved = await resolveEmailSettings();
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		return {
			channel: "email",
			delivered: false,
			status: "failed",
			message: `Email sozlamalarini o'qish imkoni bo'lmadi: ${reason}`,
		};
	}

	if (isChannelState(resolved)) {
		return {
			channel: "email",
			delivered: false,
			status: "unconfigured",
			message: resolved.message,
		};
	}

	const rendered = renderEmail(message, resolved);

	logger.warn(
		{
			event: message.event,
			subject: rendered.subject,
			to: rendered.to,
			smtpHost: resolved.smtpHost,
			smtpPort: resolved.smtpPort,
		},
		"email notification NOT sent: this backend has no SMTP transport"
	);

	return {
		channel: "email",
		delivered: false,
		status: "unsupported",
		message:
			"SMTP sozlamalari mavjud, lekin backendda SMTP transporti yo'q - xat yuborilmadi. " +
			`Xabar mavzusi: "${rendered.subject}".`,
	};
}
