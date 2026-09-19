/**
 * THE SETTINGS CACHE KEY. The subtlest leak in the whole phase.
 *
 * lib/settings holds the AI voice, the dialect, the timezone, the pricing table and
 * the audio chain, and it keeps them in an in-process Map so the voice layer does
 * not query per call. Before tenancy that Map had one entry per key. With two
 * tenants and the same Map, the first tenant to warm the cache decides what the
 * SECOND tenant's caller hears - immediately, silently, and with no query for
 * anybody to notice in a log.
 *
 * So the cache is keyed by tenant, and this file is the proof. It uses the real
 * store and the real database, because the bug it is looking for lives in exactly
 * the layer a mock would replace.
 *
 * SAFETY. It writes ONE settings row, for the VENDOR tenant (which has no calls, no
 * operators and nothing that reads its voice settings), and deletes it in afterAll.
 * The demo tenant's own rows are read but never written. `ai.dialect` is chosen for
 * the same reason ai-settings.test.ts chose it: it only changes wording, so even a
 * stray value could not break a call.
 */
import { asTenantId } from "@shared/types";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import { tenants } from "../../apps/backend/src/db/schema";
import {
	AI_DIALECTS,
	getSetting,
	invalidateSettingsCache,
	listSettings,
	resetSetting,
	SETTING_DEFINITIONS,
	setSettings,
} from "../../apps/backend/src/lib/settings";
import {
	getTenantBySlug,
	getVendorTenantId,
	invalidateTenantCache,
} from "../../apps/backend/src/lib/tenancy";

const KEY = "ai.dialect" as const;

/** A legal value that is NOT the registry default, so a leak would be visible. */
const OTHER = AI_DIALECTS.find((dialect) => dialect !== SETTING_DEFINITIONS[KEY].default);

let demoTenantId: ReturnType<typeof asTenantId>;
let vendorTenantId: ReturnType<typeof asTenantId>;

beforeAll(async () => {
	const demo = await getTenantBySlug("avilab");

	if (!demo) {
		throw new Error('No "avilab" tenant. Run bun run db:seed.');
	}

	demoTenantId = demo.id;
	vendorTenantId = await getVendorTenantId();

	if (OTHER === undefined) {
		throw new Error("the dialect registry has only one legal value; this test needs two");
	}
});

afterAll(async () => {
	// Leave nothing behind: the row is removed and every tenant's cache dropped, so a
	// following suite sees the database as it was.
	await resetSetting(vendorTenantId, KEY);
	invalidateSettingsCache();
});

describe("the settings cache is keyed by tenant", () => {
	test("two tenants exist to test with, and they are different", () => {
		// If these were ever the same value the rest of the file would pass vacuously.
		expect(demoTenantId).not.toBe(vendorTenantId);
	});

	test("a value written for one tenant is not served to another", async () => {
		if (OTHER === undefined) {
			throw new Error("unreachable");
		}

		// Warm the demo tenant's cache FIRST, which is the ordering that makes a shared
		// cache dangerous: the first reader would populate the entry every later reader
		// then trusts.
		const demoBefore = await getSetting(demoTenantId, KEY);

		await setSettings(vendorTenantId, [{ key: KEY, value: OTHER }], null);

		const vendorValue = await getSetting(vendorTenantId, KEY);
		const demoAfter = await getSetting(demoTenantId, KEY);

		expect(vendorValue).toBe(OTHER);
		// THE assertion: the other tenant's effective value did not move.
		expect(demoAfter).toBe(demoBefore);
	});

	test("the write survives a process restart, for the tenant that made it", async () => {
		if (OTHER === undefined) {
			throw new Error("unreachable");
		}

		// Dropping the cache is what a fresh process looks like: nothing but the
		// database to answer from.
		invalidateSettingsCache();

		expect(await getSetting(vendorTenantId, KEY)).toBe(OTHER);
	});

	test("dropping one tenant's cache does not change another tenant's value", async () => {
		const demoBefore = await getSetting(demoTenantId, KEY);

		invalidateSettingsCache(vendorTenantId);

		expect(await getSetting(demoTenantId, KEY)).toBe(demoBefore);
	});

	test("a tenant with no row of its own falls back to the registry default, not to a neighbour", async () => {
		if (OTHER === undefined) {
			throw new Error("unreachable");
		}

		// A third tenant, created here and removed again, so "no row" is genuinely no
		// row rather than a row somebody else wrote.
		const [created] = await db
			.insert(tenants)
			.values({
				name: "Cache probe",
				slug: `cache-probe-${Date.now().toString(36)}`,
				status: "trial",
			})
			.returning({ id: tenants.id });

		if (!created) {
			throw new Error("could not create the probe tenant");
		}

		try {
			// The vendor tenant has OTHER stored. The probe tenant must not see it.
			expect(await getSetting(created.id, KEY)).toBe(SETTING_DEFINITIONS[KEY].default);

			const snapshot = await listSettings(created.id, "ai");
			const dialect = snapshot.find((item) => item.key === KEY);

			// isStored is what tells the UI "nobody has chosen this". Inheriting another
			// tenant's row would make it report a choice the customer never made.
			expect(dialect?.isStored).toBe(false);
		} finally {
			invalidateSettingsCache(created.id);
			await db.delete(tenants).where(eq(tenants.id, created.id));
			// The tenant registry memoises "is there exactly one customer" (the
			// transitional seam the voice layer still uses), and this test briefly made
			// the answer two. Dropping the cache is what the vendor console does after
			// creating a tenant, and skipping it here would leave a later suite in this
			// process being told there is no single tenant.
			invalidateTenantCache();
		}
	});
});
