/**
 * The layer the unit tests cannot reach: a stored row.
 *
 * apps/backend/src/lib/settings/ai-config.test.ts covers .env over the built-in
 * default and every validation rule. What is left is the claim the AI settings
 * page is built on - that a change is written to Postgres, wins over .env, and is
 * still there when the process starts again - and that needs the real store.
 *
 * The "restart" is simulated by dropping the in-process cache: after that, the
 * next read has nothing but the database to answer from, which is exactly the
 * state a fresh process is in.
 *
 * SAFETY. This file writes exactly one settings row and restores it in afterAll -
 * back to the stored row if there was one, or to no row at all if there was not -
 * so a failing assertion cannot leave the running agent reconfigured. ai.dialect
 * is chosen deliberately: it is the one AI setting that changes only wording, so
 * even a stray value could not break a call.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	AI_DIALECTS,
	clearAiRuntimeConfigSnapshot,
	getSetting,
	invalidateSettingsCache,
	listSettings,
	refreshAiRuntimeConfig,
	resetSetting,
	SETTING_DEFINITIONS,
	setSettings,
} from "../../apps/backend/src/lib/settings";
import { getTenantBySlug, type TenantId } from "../../apps/backend/src/lib/tenancy";

const KEY = "ai.dialect" as const;

/**
 * A legal value that is NOT the registry default, so writing it always moves the
 * effective value - setSettings() skips a write that would change nothing, which
 * is exactly what a "wrote the default onto a deleted row" case would look like.
 */
const OTHER =
	AI_DIALECTS.find((dialect) => dialect !== SETTING_DEFINITIONS[KEY].default) ?? "xorazm";

/** What the row looked like before this file touched it. */
let original: { isStored: boolean; value: string };

/**
 * Whose settings these are.
 *
 * Settings became tenant-scoped with the tenancy migration: the store keeps one
 * cache per tenant and every read takes the tenant first. This suite exercises the
 * demo tenant, which is the tenant these rows already belonged to - the backfill
 * moved them there - so what it asserts is unchanged.
 */
let tenantId: TenantId;

beforeAll(async () => {
	const tenant = await getTenantBySlug("avilab");

	if (tenant === null) {
		throw new Error('No "avilab" tenant - run bun run db:seed');
	}

	tenantId = tenant.id;

	const item = (await listSettings(tenantId, "ai")).find((entry) => entry.key === KEY);

	if (item === undefined) {
		throw new Error("ai.dialect is not registered - the AI settings category is missing");
	}

	original = { isStored: item.isStored, value: item.value as string };
});

afterAll(async () => {
	if (original.isStored) {
		await setSettings(tenantId, [{ key: KEY, value: original.value }], null);
	} else {
		await resetSetting(tenantId, KEY);
	}

	// Leave the process as this file found it: cold. The synchronous snapshot lives
	// on globalThis, so a refreshed one would follow this file into every test that
	// runs after it and quietly replace their registry defaults with whatever this
	// database happens to hold.
	clearAiRuntimeConfigSnapshot();
});

describe("a stored AI setting beats .env", () => {
	test("with no row, the effective value is the registry default (which is .env)", async () => {
		await resetSetting(tenantId, KEY);

		expect(await getSetting(tenantId, KEY)).toBe(SETTING_DEFINITIONS[KEY].default as string);

		const listed = (await listSettings(tenantId, "ai")).find((entry) => entry.key === KEY);

		expect(listed?.isStored).toBe(false);
	});

	test("a written row wins, and survives a cold cache", async () => {
		const changes = await setSettings(tenantId, [{ key: KEY, value: OTHER }], null);

		expect(changes).toHaveLength(1);
		expect(changes[0]?.after).toBe(OTHER);

		// The "restart": nothing in memory, so the answer can only come from Postgres.
		invalidateSettingsCache();

		expect(await getSetting(tenantId, KEY)).toBe(OTHER);

		const listed = (await listSettings(tenantId, "ai")).find((entry) => entry.key === KEY);

		expect(listed?.isStored).toBe(true);
		expect(listed?.updatedAt).not.toBeNull();
	});

	test("the resolved runtime config reads the stored row, not the environment", async () => {
		invalidateSettingsCache();

		const config = await refreshAiRuntimeConfig(tenantId);

		expect(config.dialect).toBe(OTHER);
	});

	test("removing the row falls back to .env again", async () => {
		await resetSetting(tenantId, KEY);
		invalidateSettingsCache();

		expect(await getSetting(tenantId, KEY)).toBe(SETTING_DEFINITIONS[KEY].default as string);
	});
});

describe("an unusable value never reaches the database", () => {
	test("a Gemini model with no live endpoint is refused, and nothing is stored", async () => {
		const before = await getSetting(tenantId, "ai.gemini.model");

		await expect(
			setSettings(tenantId, [{ key: "ai.gemini.model", value: "gemini-2.5-flash" }], null)
		).rejects.toThrow(/live/);

		invalidateSettingsCache();

		expect(await getSetting(tenantId, "ai.gemini.model")).toBe(before);
	});

	test("a batch is refused whole, so a half-applied form is impossible", async () => {
		const before = await getSetting(tenantId, KEY);

		await expect(
			setSettings(
				tenantId,
				[
					{ key: KEY, value: OTHER },
					{ key: "ai.transferExtensions", value: "101,operator" },
				],
				null
			)
		).rejects.toThrow(/vergul/);

		invalidateSettingsCache();

		expect(await getSetting(tenantId, KEY)).toBe(before);
	});
});
