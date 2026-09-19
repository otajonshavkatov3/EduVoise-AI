/**
 * The two tenant rows every other seed depends on.
 *
 * `db:reset` truncates every table, tenants included, so the seed chain has to be
 * able to put them back - and every other seed needs a tenant to attach its rows
 * to. This runs first (from seed.ts) and is idempotent, so re-running any seed is
 * safe.
 *
 * TWO ROWS, and they are not the same kind of thing:
 *
 *   vendor  the platform owner's own tenant. Vendor staff are users of it. It has
 *           no calls, no operators and no campaigns; it exists so that
 *           `users.tenant_id` can be NOT NULL for everybody, which is what stops a
 *           user from being valid inside every customer at once.
 *   demo    the first CUSTOMER - the AviLab account this platform was built
 *           against. The tenancy migration created it and moved every existing row
 *           onto it; this file recreates it after a reset with the same slug, so a
 *           reset-and-seed cycle produces the same tenant the migration did.
 */
import type { TenantId } from "@shared/types";
import { eq } from "drizzle-orm";
import { generateWebhookToken } from "@/lib/tenancy";
import { db } from "./index";
import { tenants } from "./schema";

/**
 * The SLUG is the stable identifier, not the id.
 *
 * Deliberately no hardcoded uuids: nothing in the application keys off a tenant's
 * id value - the vendor row is found by its `is_vendor` flag and the demo row by
 * its slug - so a constant uuid would be a magic value with nothing to justify it,
 * and both the migration and this file would have to keep agreeing on it forever.
 * They agree on the slug instead, which is unique and CHECK-constrained.
 */
export const VENDOR_TENANT_SLUG = "vendor";
export const DEMO_TENANT_SLUG = "avilab";

async function ensureTenant(row: {
	slug: string;
	name: string;
	isVendor: boolean;
	status: "trial" | "active";
}): Promise<TenantId> {
	const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, row.slug) });

	if (existing) {
		return existing.id;
	}

	const [inserted] = await db
		.insert(tenants)
		.values({
			slug: row.slug,
			name: row.name,
			isVendor: row.isVendor,
			status: row.status,
			timezone: "Asia/Tashkent",
			// A credential, so it is generated here rather than defaulted in the
			// column: a database default would be the same shape for every install.
			webhookToken: generateWebhookToken(),
		})
		.returning({ id: tenants.id });

	if (!inserted) {
		throw new Error(`could not seed the ${row.slug} tenant`);
	}

	return inserted.id;
}

export async function ensureVendorTenant(): Promise<TenantId> {
	return await ensureTenant({
		slug: VENDOR_TENANT_SLUG,
		name: "Platforma egasi",
		isVendor: true,
		status: "active",
	});
}

export async function ensureDemoTenant(): Promise<TenantId> {
	return await ensureTenant({
		slug: DEMO_TENANT_SLUG,
		name: "AviLab",
		isVendor: false,
		status: "active",
	});
}

/**
 * The demo tenant, for a seed that must not create it.
 *
 * Throws instead of creating: seedSipExtensions and seedAiAgent add rows to an
 * existing customer, and a customer they invented would be a customer nobody can
 * log into.
 */
export async function requireDemoTenant(): Promise<TenantId> {
	const row = await db.query.tenants.findFirst({ where: eq(tenants.slug, DEMO_TENANT_SLUG) });

	if (!row) {
		throw new Error(`No "${DEMO_TENANT_SLUG}" tenant. Run \`bun run db:seed\` first.`);
	}

	return row.id;
}
