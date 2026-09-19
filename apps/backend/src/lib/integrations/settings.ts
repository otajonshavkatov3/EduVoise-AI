/**
 * Settings access for the integrations layer.
 *
 * Every credential used here (Telegram bot token and chat id
 * token, SMTP host) has to be changeable by an operator without a redeploy, so
 * none of them live in the environment: they are rows in `system_settings`.
 *
 * Two readers, one source of truth:
 *
 *   - a key in the shared registry (`@/lib/settings`) is read through it, so the
 *     registry's default, its validation and its cache invalidation on save all
 *     apply. Anything an admin can edit on the Settings page goes this way.
 *   - a key the registry does not define is read straight from the table. Those
 *     are the adapter's tuning knobs (request path, timeout, auth scheme, alert
 *     windows). They have no Settings UI, they are absent in a normal install,
 *     and the defaults in `config.ts` / `monitor.ts` then apply. A row inserted
 *     by hand still works, and adding the key to the registry later needs no
 *     change here.
 *
 * Raw reads are cached for a few seconds: the cache exists so one send does not
 * issue eight identical single-row queries, and the TTL is short so a settings
 * change is picked up almost immediately.
 *
 * TENANT. Everything here is one tenant's configuration - their Telegram chat,
 * their SMTP relay, their alert windows - so every read is scoped, and the cache is
 * keyed by tenant and key together.
 *
 * TODO(tenancy): the notification layer above this file (monitor, notifier,
 * telegram, email) is still process-wide: it wakes on a timer and asks "has
 * anything gone wrong", with no tenant in the question. Making that per-tenant is a
 * later phase's work - it changes what the feature IS, not just how it reads a
 * setting. Until then the tenant is resolved here, at the one boundary, by
 * getSoleTenantId(), which throws the moment a second customer exists rather than
 * sending customer A's alert to customer B's Telegram group.
 */
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { systemSettings } from "@/db/schema";
import {
	getSetting as getRegistrySetting,
	invalidateSettingsCache,
	isSettingKey,
} from "@/lib/settings";
import { getSoleTenantId, tenantWhere } from "@/lib/tenancy";

const CACHE_TTL_MS = 10_000;

type CacheEntry = {
	value: unknown;
	expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

/**
 * Unwraps `{ "value": X }`.
 *
 * `system_settings.value` is jsonb, so a plain string setting is stored as a
 * JSON string. A generic key/value writer can just as easily store the same
 * setting wrapped in an object, and a token that reads back as
 * `{"value":"abc"}` would be sent to the remote API as the literal text
 * `[object Object]`. Only a single-key object named `value` is unwrapped, so a
 * setting whose real value is an object is left untouched.
 */
function unwrapSettingValue(raw: unknown): unknown {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const keys = Object.keys(raw as Record<string, unknown>);
		if (keys.length === 1 && keys[0] === "value") {
			return (raw as { value: unknown }).value;
		}
	}
	return raw;
}

/**
 * Reads one setting, registered or not. Returns null when there is no value -
 * "not configured" and "configured as null" are the same thing to every caller
 * here, and the registry's empty-string default for an unset token reads as null
 * through `getStringSetting`.
 *
 * Throws only if the database itself is unreachable. Callers on a call path
 * (notifications) must therefore keep their try/catch; callers on a request
 * path let it surface as a 500, which is the honest answer.
 */
export async function getSetting<T = unknown>(key: string): Promise<T | null> {
	const tenantId = await getSoleTenantId();

	if (isSettingKey(key)) {
		return ((await getRegistrySetting(tenantId, key)) ?? null) as T | null;
	}

	const cacheKey = `${tenantId}:${key}`;
	const cached = cache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.value as T | null;
	}

	const [row] = await db
		.select({ value: systemSettings.value })
		.from(systemSettings)
		.where(tenantWhere(systemSettings, tenantId, eq(systemSettings.key, key)))
		.limit(1);

	const value = row ? (unwrapSettingValue(row.value) ?? null) : null;
	cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
	return value as T | null;
}

/** Empty and whitespace-only strings count as "not set" - a blank token is not a token. */
export async function getStringSetting(key: string): Promise<string | null> {
	const value = await getSetting(key);

	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	return null;
}

/** Accepts real booleans plus the strings/numbers a settings form tends to produce. */
export async function getBooleanSetting(key: string, fallback: boolean): Promise<boolean> {
	const value = await getSetting(key);

	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value !== 0;
	}
	if (typeof value === "string") {
		const normalised = value.trim().toLowerCase();
		if (["true", "1", "yes", "on", "ha"].includes(normalised)) {
			return true;
		}
		if (["false", "0", "no", "off", "yo'q"].includes(normalised)) {
			return false;
		}
	}

	return fallback;
}

export async function getNumberSetting(key: string, fallback: number): Promise<number> {
	const value = await getSetting(key);

	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return fallback;
}

/** Numbers only; anything else is dropped. Used for the business-hours weekday list. */
export async function getNumberArraySetting(key: string, fallback: number[]): Promise<number[]> {
	const value = await getSetting(key);

	if (Array.isArray(value)) {
		const numbers = value
			.map((entry) => (typeof entry === "number" ? entry : Number(entry)))
			.filter((entry) => Number.isFinite(entry));
		return numbers.length > 0 ? numbers : fallback;
	}

	if (typeof value === "string" && value.trim().length > 0) {
		const numbers = value
			.split(",")
			.map((entry) => Number(entry.trim()))
			.filter((entry) => Number.isFinite(entry));
		return numbers.length > 0 ? numbers : fallback;
	}

	return fallback;
}

/**
 * Drops cached values. Call after writing a setting so the next read is fresh;
 * with no argument it clears everything, the shared registry cache included.
 */
export function clearIntegrationSettingsCache(key?: string): void {
	if (key) {
		// Cache entries are prefixed with the tenant, so one key can have an entry per
		// tenant; all of them are dropped, which is what "this setting changed" means.
		for (const cached of cache.keys()) {
			if (cached.endsWith(`:${key}`)) {
				cache.delete(cached);
			}
		}

		if (isSettingKey(key)) {
			invalidateSettingsCache();
		}
		return;
	}

	cache.clear();
	invalidateSettingsCache();
}
