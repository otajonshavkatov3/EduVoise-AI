/**
 * Outbound integrations barrel.
 *
 *   notifications  Telegram / e-mail alerting for operational problems.
 *   settings       shared reader for the `system_settings` rows it uses.
 *   logging        pino children plus the redaction helpers every adapter runs
 *                  its URLs, errors and bodies through.
 *
 * No integration carries a credential in the source or in the environment: an
 * unconfigured integration reports itself as unconfigured and does nothing.
 *
 * A government-portal adapter used to live here. It was removed deliberately:
 * this platform is a configurable AI call centre sold to business owners, not a
 * client of one municipal portal, so a hardcoded government integration does not
 * belong in the product.
 */

export {
	createIntegrationLogger,
	maskPhone,
	REDACTED,
	redactSecrets,
	truncateForLog,
} from "./logging";
export * as notifications from "./notifications";
export {
	clearIntegrationSettingsCache,
	getBooleanSetting,
	getNumberArraySetting,
	getNumberSetting,
	getSetting,
	getStringSetting,
} from "./settings";
