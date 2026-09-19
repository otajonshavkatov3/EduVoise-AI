/**
 * Logging helpers shared by the integration adapters.
 *
 * Outbound integration calls are the hardest thing to debug after the fact, so
 * they are logged in full - which is exactly why redaction has to be mechanical
 * rather than remembered at each call site. `redactSecrets` is applied to every
 * URL, error message and response body before it reaches pino, because a remote
 * service that echoes the request back (or an error that includes the full URL)
 * will otherwise put a live token in the log file.
 */
import pino from "pino";
import pretty from "pino-pretty";

const isProduction = process.env.NODE_ENV === "production";

export const REDACTED = "***redacted***";

export function createIntegrationLogger(name: string) {
	return pino(
		{
			level: isProduction ? "info" : "debug",
			name,
		},
		isProduction ? undefined : pretty({ colorize: true })
	);
}

/**
 * Replaces every occurrence of every secret with `***redacted***`.
 *
 * Secrets shorter than 8 characters are skipped: a 3-character "token" would
 * match half the words in a message and make the log unreadable, and it is not
 * a credential worth protecting anyway.
 */
export function redactSecrets(text: string, secrets: (string | null | undefined)[]): string {
	let output = text;

	for (const secret of secrets) {
		if (!secret || secret.length < 8) {
			continue;
		}
		output = output.split(secret).join(REDACTED);
	}

	return output;
}

/**
 * Keeps the country code and the last two digits: +998901234567 -> +998*****67.
 *
 * Enough to recognise a caller in a log line while investigating, not enough to
 * be a phone book. Applied to the applicant number in the payload we log.
 */
export function maskPhone(phone: string | null | undefined): string | null {
	if (!phone) {
		return null;
	}

	const trimmed = phone.trim();
	if (trimmed.length <= 6) {
		return "***";
	}

	const head = trimmed.slice(0, 4);
	const tail = trimmed.slice(-2);
	return `${head}${"*".repeat(Math.max(trimmed.length - 6, 1))}${tail}`;
}

/** Truncates a response body so one HTML error page cannot fill the log. */
export function truncateForLog(text: string, maxLength = 600): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}... (${text.length} bayt, qisqartirildi)`;
}
