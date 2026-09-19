/**
 * Telegram notification channel.
 *
 * Bot token and chat id come from `system_settings`, so an admin can point
 * alerts at a different group without a redeploy.
 *
 * Two deliberate choices:
 *
 *   - messages are sent as plain text, with no `parse_mode`. Alert bodies
 *     contain operator-supplied text (ticket subjects, remote error messages);
 *     with HTML or Markdown parsing on, a stray `<` or `_` turns a real alert
 *     into a 400 from Telegram. A missed alert is worse than an unstyled one.
 *   - the token is part of the request URL, so the URL is never logged raw -
 *     `redactSecrets` is applied to it, and to any error text that might echo it.
 *
 * Nothing here throws. A dead Telegram must not affect a call, a ticket send or
 * anything else on the path that raised the alert.
 */
import { createIntegrationLogger, redactSecrets, truncateForLog } from "../logging";
import { getBooleanSetting, getStringSetting } from "../settings";
import type { ChannelDeliveryResult, ChannelState } from "./types";

const logger = createIntegrationLogger("integrations:telegram");

export const TELEGRAM_SETTING_KEYS = {
	/** Master switch for all notifications, shared with the e-mail channel. */
	enabled: "notifications.enabled",
	botToken: "notifications.telegram.botToken",
	chatId: "notifications.telegram.chatId",
	/** Unregistered: overriding the API host is for tests, not for operators. */
	apiBaseUrl: "notifications.telegram.apiBaseUrl",
} as const;

const DEFAULT_API_BASE_URL = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 700;
/** Telegram rejects anything longer than 4096 characters. */
const MAX_TEXT_LENGTH = 4000;

interface TelegramConfig {
	botToken: string;
	chatId: string;
	apiBaseUrl: string;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function resolveTelegramConfig(): Promise<TelegramConfig | ChannelState> {
	const enabled = await getBooleanSetting(TELEGRAM_SETTING_KEYS.enabled, false);

	if (!enabled) {
		return {
			configured: false,
			message:
				"Bildirishnomalar o'chirilgan. Sozlamalar bo'limida " +
				'"notifications.enabled" ni yoqing.',
			missingKeys: [TELEGRAM_SETTING_KEYS.enabled],
		};
	}

	const botToken = await getStringSetting(TELEGRAM_SETTING_KEYS.botToken);
	const chatId = await getStringSetting(TELEGRAM_SETTING_KEYS.chatId);
	const missingKeys: string[] = [];

	if (!botToken) {
		missingKeys.push(TELEGRAM_SETTING_KEYS.botToken);
	}
	if (!chatId) {
		missingKeys.push(TELEGRAM_SETTING_KEYS.chatId);
	}

	if (!(botToken && chatId)) {
		return {
			configured: false,
			message: `Telegram sozlanmagan. Yetishmayotgan sozlamalar: ${missingKeys.join(", ")}.`,
			missingKeys,
		};
	}

	const apiBaseUrl = (
		(await getStringSetting(TELEGRAM_SETTING_KEYS.apiBaseUrl)) ?? DEFAULT_API_BASE_URL
	).replace(/\/+$/, "");

	return { botToken, chatId, apiBaseUrl };
}

function isChannelState(value: TelegramConfig | ChannelState): value is ChannelState {
	return "configured" in value;
}

/** Whether Telegram alerts can be delivered, without sending anything. */
export async function getTelegramChannelState(): Promise<ChannelState> {
	try {
		const resolved = await resolveTelegramConfig();
		if (isChannelState(resolved)) {
			return resolved;
		}
		return { configured: true, message: "Telegram sozlangan.", missingKeys: [] };
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		return {
			configured: false,
			message: `Telegram sozlamalarini o'qish imkoni bo'lmadi: ${reason}`,
			missingKeys: [],
		};
	}
}

function unconfigured(state: ChannelState): ChannelDeliveryResult {
	return {
		channel: "telegram",
		delivered: false,
		status: "unconfigured",
		message: state.message,
	};
}

interface TelegramAttempt {
	status: number | null;
	body: string;
	/** Uzbek transport failure text, already redacted. Null on any HTTP reply. */
	transportError: string | null;
	retryable: boolean;
}

async function postSendMessage(
	config: TelegramConfig,
	text: string,
	secrets: string[]
): Promise<TelegramAttempt> {
	const url = `${config.apiBaseUrl}/bot${config.botToken}/sendMessage`;
	const body = {
		// biome-ignore lint/style/useNamingConvention: Telegram Bot API field name.
		chat_id: config.chatId,
		text: text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}...` : text,
		// biome-ignore lint/style/useNamingConvention: Telegram Bot API field name.
		disable_web_page_preview: true,
	};

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});

		const rawBody = response.ok
			? ""
			: redactSecrets(truncateForLog(await response.text().catch(() => ""), 300), secrets);

		return {
			status: response.status,
			body: rawBody,
			transportError: null,
			retryable: response.status >= 500,
		};
	} catch (cause) {
		const isTimeout = cause instanceof Error && cause.name === "TimeoutError";
		const reason = redactSecrets(cause instanceof Error ? cause.message : String(cause), secrets);

		return {
			status: null,
			body: "",
			transportError: isTimeout
				? `Telegram ${TIMEOUT_MS} ms ichida javob bermadi.`
				: `Telegram bilan aloqa o'rnatilmadi: ${reason}`,
			retryable: true,
		};
	}
}

/**
 * Sends one plain-text message. Returns the outcome; never rejects.
 *
 * One retry, on a 5xx or a transport failure only - a 400 from Telegram means
 * the chat id is wrong or the bot was removed, and retrying that is pointless.
 */
export async function sendTelegramMessage(text: string): Promise<ChannelDeliveryResult> {
	let resolved: TelegramConfig | ChannelState;

	try {
		resolved = await resolveTelegramConfig();
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		logger.error({ err: reason }, "telegram settings could not be read");
		return {
			channel: "telegram",
			delivered: false,
			status: "failed",
			message: `Telegram sozlamalarini o'qish imkoni bo'lmadi: ${reason}`,
		};
	}

	if (isChannelState(resolved)) {
		return unconfigured(resolved);
	}

	const config = resolved;
	const secrets = [config.botToken];
	const safeUrl = redactSecrets(`${config.apiBaseUrl}/bot${config.botToken}/sendMessage`, secrets);

	let attempts = 0;
	let attempt = await postSendMessage(config, text, secrets);
	attempts += 1;

	while (attempt.retryable && attempts < MAX_ATTEMPTS) {
		logger.warn(
			{ url: safeUrl, attempts, status: attempt.status, err: attempt.transportError },
			"telegram alert failed, retrying once"
		);
		await delay(RETRY_DELAY_MS);
		attempt = await postSendMessage(config, text, secrets);
		attempts += 1;
	}

	if (attempt.transportError) {
		logger.error(
			{ url: safeUrl, attempts, err: attempt.transportError },
			"telegram alert transport failure"
		);
		return {
			channel: "telegram",
			delivered: false,
			status: "failed",
			message: attempt.transportError,
		};
	}

	const httpStatus = attempt.status ?? 0;

	if (httpStatus >= 200 && httpStatus < 300) {
		logger.info({ url: safeUrl, chatId: config.chatId, attempts }, "telegram alert sent");
		return {
			channel: "telegram",
			delivered: true,
			status: "sent",
			message: "Telegram xabari yuborildi.",
		};
	}

	logger.error(
		{ url: safeUrl, status: httpStatus, attempts, body: attempt.body },
		"telegram alert rejected"
	);

	return {
		channel: "telegram",
		delivered: false,
		status: "failed",
		message: `Telegram HTTP ${httpStatus} qaytardi: ${attempt.body || "(bo'sh javob)"}`,
	};
}
