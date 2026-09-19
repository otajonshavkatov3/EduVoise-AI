/**
 * Read/write access to the runtime settings, backed by the system_settings table.
 *
 * Nothing outside this file should touch that table. A caller says
 *
 *   const enabled = await getSetting("notifications.enabled");
 *
 * and gets a boolean - already validated against the registry schema, already
 * falling back to the registered default when no row exists. No SQL, no JSON
 * casting, no "what if the row is missing" branch at every call site.
 *
 * TENANT-SCOPED. Every value here belongs to ONE customer: the AI voice, the
 * dialect, the timezone, the pricing table, the audio chain. So every function
 * takes the tenant first -
 *
 *   const enabled = await getSetting(tenantId, "notifications.enabled");
 *
 * - and there is no unscoped variant left to reach for by accident.
 *
 * Caching: settings are read on nearly every request that touches an integration
 * and written a handful of times a month, so a tenant's whole table is held in an
 * in-process Map and dropped on write. The cache is keyed BY TENANT (a Map of
 * Maps), which is the whole point: one global Map here would serve tenant A's
 * voice to tenant B's caller, silently and immediately. The backend is a single
 * Bun process, so invalidate-on-write is sufficient; a second process would need a
 * channel, and refreshSettings() exists for exactly that day.
 *
 * Secrets are returned in full here. Masking is the HTTP layer's job
 * (routes/settings) - code that needs a token to sign a request obviously cannot
 * work with "***".
 */
import type { TenantId } from "@shared/types";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { systemSettings } from "@/db/schema";
import { invalidInput } from "@/lib/errors";
import { tenantWhere } from "@/lib/tenancy";
import {
	getSettingDefinition,
	isSettingKey,
	SETTING_DEFINITIONS,
	SETTING_KEYS,
	type SettingCategory,
	type SettingDefinition,
	type SettingKey,
	type SettingPrimitive,
	type SettingValueOf,
} from "./registry";

interface CachedSetting {
	value: SettingPrimitive;
	updatedAt: Date;
}

type SettingCache = Map<SettingKey, CachedSetting>;

/** One cache per tenant. Never a shared entry - see the file header. */
const caches = new Map<TenantId, SettingCache>();

/** In-flight loads, also per tenant, so concurrent readers share one query. */
const inFlight = new Map<TenantId, Promise<SettingCache>>();

/**
 * Rows that could not be used, keyed by the row's key. Populated on load when a
 * stored value no longer satisfies its schema (someone tightened the registry) or
 * when a key was removed from the registry entirely. Surfaced through
 * getSettingsLoadWarnings() so an HTTP handler can log it with its own logger -
 * this module has no logger of its own and must not write to the console.
 */
const loadWarnings = new Map<string, Map<string, string>>();

function warningsFor(tenantId: TenantId): Map<string, string> {
	const existing = loadWarnings.get(tenantId);

	if (existing) {
		return existing;
	}

	const created = new Map<string, string>();
	loadWarnings.set(tenantId, created);

	return created;
}

async function readAllRows(tenantId: TenantId): Promise<SettingCache> {
	const rows = await db
		.select({
			key: systemSettings.key,
			value: systemSettings.value,
			updatedAt: systemSettings.updatedAt,
		})
		.from(systemSettings)
		.where(tenantWhere(systemSettings, tenantId));

	const next: SettingCache = new Map();
	const warnings = warningsFor(tenantId);
	warnings.clear();

	for (const row of rows) {
		if (!isSettingKey(row.key)) {
			warnings.set(row.key, "registrda bunday sozlama yo'q — qiymat e'tiborsiz qoldirildi");
			continue;
		}

		const parsed = getSettingDefinition(row.key).schema.safeParse(row.value);

		if (!parsed.success) {
			// Keep serving the default rather than propagating a bad value.
			warnings.set(row.key, "saqlangan qiymat sxemaga mos emas — standart qiymat ishlatiladi");
			continue;
		}

		next.set(row.key, { value: parsed.data, updatedAt: row.updatedAt });
	}

	return next;
}

/** Load one tenant once, then serve from memory. Concurrent callers share one query. */
async function loadCache(tenantId: TenantId): Promise<SettingCache> {
	const cached = caches.get(tenantId);

	if (cached) {
		return cached;
	}

	const pending = inFlight.get(tenantId);

	if (pending) {
		return await pending;
	}

	const promise = readAllRows(tenantId);
	inFlight.set(tenantId, promise);

	try {
		const loaded = await promise;
		caches.set(tenantId, loaded);
		return loaded;
	} finally {
		inFlight.delete(tenantId);
	}
}

/**
 * Drop a tenant's cache. The next read hits the database.
 *
 * With no argument it drops every tenant, which is what a test needs and what a
 * process-wide reload does; a write only ever invalidates the tenant it wrote, so
 * one customer saving a setting does not make every other customer re-query.
 */
export function invalidateSettingsCache(tenantId?: TenantId): void {
	if (tenantId) {
		caches.delete(tenantId);
		return;
	}

	caches.clear();
}

/** Drop a tenant's cache and immediately reload it. */
export async function refreshSettings(tenantId: TenantId): Promise<void> {
	invalidateSettingsCache(tenantId);
	await loadCache(tenantId);
}

/** Problems found while loading, so a caller with a logger can report them. */
export function getSettingsLoadWarnings(tenantId: TenantId): { key: string; reason: string }[] {
	return Array.from(loadWarnings.get(tenantId) ?? [], ([key, reason]) => ({ key, reason }));
}

function effectiveValue(map: SettingCache, key: SettingKey): SettingPrimitive {
	return map.get(key)?.value ?? SETTING_DEFINITIONS[key].default;
}

export async function getSetting<K extends SettingKey>(
	tenantId: TenantId,
	key: K
): Promise<SettingValueOf<K>> {
	const map = await loadCache(tenantId);
	return effectiveValue(map, key) as SettingValueOf<K>;
}

type SettingValues<K extends SettingKey> = { [P in K]: SettingValueOf<P> };

/**
 * Several settings in one call, so a consumer reads its whole configuration
 * without awaiting once per key.
 */
export async function getSettings<K extends SettingKey>(
	tenantId: TenantId,
	keys: readonly K[]
): Promise<SettingValues<K>> {
	const map = await loadCache(tenantId);
	const result = {} as SettingValues<K>;

	for (const key of keys) {
		result[key] = effectiveValue(map, key) as SettingValues<K>[K];
	}

	return result;
}

export interface SettingSnapshotItem {
	key: SettingKey;
	definition: SettingDefinition;
	/** The real value, secrets included. The HTTP layer masks. */
	value: SettingPrimitive;
	/** False when no row exists yet and the registry default is in use. */
	isStored: boolean;
	updatedAt: Date | null;
}

/** Every registered setting with its effective value, in registry order. */
export async function listSettings(
	tenantId: TenantId,
	category?: SettingCategory
): Promise<SettingSnapshotItem[]> {
	const map = await loadCache(tenantId);

	return SETTING_KEYS.filter(
		(key) => category === undefined || SETTING_DEFINITIONS[key].category === category
	).map((key) => {
		const definition = SETTING_DEFINITIONS[key];
		const stored = map.get(key);

		return {
			key,
			definition,
			value: stored?.value ?? definition.default,
			isStored: stored !== undefined,
			updatedAt: stored?.updatedAt ?? null,
		};
	});
}

export interface SettingWrite {
	key: SettingKey;
	value: SettingPrimitive;
}

export interface SettingChange {
	key: SettingKey;
	before: SettingPrimitive;
	after: SettingPrimitive;
	isSecret: boolean;
}

/**
 * Validate a write against its own schema. Throws the same 400 the HTTP layer
 * would, so a programmatic caller cannot slip an invalid value past the registry.
 */
function validateWrite(write: SettingWrite): SettingPrimitive {
	const definition = SETTING_DEFINITIONS[write.key];
	const parsed = definition.schema.safeParse(write.value);

	if (!parsed.success) {
		const reason = parsed.error.issues[0]?.message ?? "qiymat yaroqsiz";
		throw invalidInput(write.key, reason);
	}

	return parsed.data;
}

/**
 * Persist one or more settings.
 *
 * Writes that would not change the effective value are skipped, which keeps
 * "Saqlash" on an untouched form from producing a row, an audit entry and a
 * cache flush for nothing. The return value lists only the real changes.
 */
export async function setSettings(
	tenantId: TenantId,
	writes: readonly SettingWrite[],
	updatedBy: string | null
): Promise<SettingChange[]> {
	const map = await loadCache(tenantId);
	const changes: SettingChange[] = [];
	const pending: { key: SettingKey; value: SettingPrimitive; definition: SettingDefinition }[] = [];

	for (const write of writes) {
		const definition = SETTING_DEFINITIONS[write.key];
		const value = validateWrite(write);
		const stored = map.get(write.key);
		const before = stored?.value ?? definition.default;

		if (value === before && (stored !== undefined || value === definition.default)) {
			continue;
		}

		pending.push({ key: write.key, value, definition });
		changes.push({
			key: write.key,
			before,
			after: value,
			isSecret: definition.type === "secret",
		});
	}

	if (pending.length === 0) {
		return [];
	}

	const now = new Date();

	await db.transaction(async (tx) => {
		for (const item of pending) {
			await tx
				.insert(systemSettings)
				.values({
					tenantId,
					key: item.key,
					category: item.definition.category,
					value: item.value,
					description: item.definition.description,
					isSecret: item.definition.type === "secret",
					updatedBy,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					// The conflict target is the (tenant_id, key) unique index, not key
					// alone: two tenants both storing "ai.dialect" is the normal case, and
					// conflicting on key would have one silently overwrite the other.
					target: [systemSettings.tenantId, systemSettings.key],
					set: {
						category: item.definition.category,
						value: item.value,
						description: item.definition.description,
						isSecret: item.definition.type === "secret",
						updatedBy,
						updatedAt: now,
					},
				});
		}
	});

	invalidateSettingsCache(tenantId);

	return changes;
}

/** Single-key convenience wrapper. Returns null when nothing changed. */
export async function setSetting<K extends SettingKey>(
	tenantId: TenantId,
	key: K,
	value: SettingValueOf<K>,
	updatedBy: string | null
): Promise<SettingChange | null> {
	// SettingValueOf<K> is always string | number | boolean - every registry entry
	// is built with T extends SettingPrimitive - but that does not survive the
	// generic indirection, hence the cast.
	const writes: SettingWrite[] = [{ key, value: value as SettingPrimitive }];
	const changes = await setSettings(tenantId, writes, updatedBy);

	return changes[0] ?? null;
}

/**
 * Delete a stored row so the setting falls back to its registry default.
 * Used by tooling and tests; the Settings UI writes explicit values instead.
 */
export async function resetSetting(tenantId: TenantId, key: SettingKey): Promise<void> {
	await db
		.delete(systemSettings)
		.where(and(eq(systemSettings.tenantId, tenantId), eq(systemSettings.key, key)));
	invalidateSettingsCache(tenantId);
}
