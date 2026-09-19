/**
 * The vendor's own account - the super-admin above every tenant.
 *
 * A separate script rather than part of the tenancy migration, for one reason: a
 * password has to be hashed, and a migration is SQL. It is idempotent, so running
 * it twice is safe, and it never touches an existing row's password - a script that
 * reset the owner's password on every deploy would be worse than no script.
 *
 *   bun run db:seed:vendor
 *
 * Credentials come from the environment when set (VENDOR_PHONE, VENDOR_PASSWORD)
 * and otherwise fall back to a development default that is printed on creation.
 * The default is fine on a laptop and unacceptable in production, which is why it
 * is printed with that sentence attached.
 */

import { eq } from "drizzle-orm";
import { hashPassword } from "@/lib/auth";

import { db } from "./index";
import { users } from "./schema";
import { ensureVendorTenant } from "./seedTenants";

const VENDOR_PHONE = process.env.VENDOR_PHONE ?? "+998900000001";
const VENDOR_PASSWORD = process.env.VENDOR_PASSWORD ?? "vendor123";

async function seedVendor(): Promise<void> {
	const tenantId = await ensureVendorTenant();

	const existing = await db.query.users.findFirst({
		where: eq(users.phone, VENDOR_PHONE),
		columns: { id: true, role: true, tenantId: true },
	});

	if (existing) {
		// The account is here. Its password is deliberately left alone; only the role
		// and tenant are corrected, because those two are what make it a vendor and a
		// wrong value there is a broken installation rather than a preference.
		if (existing.role !== "vendor" || existing.tenantId !== tenantId) {
			await db.update(users).set({ role: "vendor", tenantId }).where(eq(users.id, existing.id));
			console.log(`vendor account ${VENDOR_PHONE}: role and tenant corrected`);
			return;
		}

		console.log(`vendor account ${VENDOR_PHONE} already exists - nothing to do`);
		return;
	}

	const passwordHash = await hashPassword(VENDOR_PASSWORD);

	await db.insert(users).values({
		tenantId,
		phone: VENDOR_PHONE,
		username: "Platforma egasi",
		passwordHash,
		role: "vendor",
		isActive: true,
	});

	console.log("vendor account created");
	console.log(`  phone:    ${VENDOR_PHONE}`);
	console.log(`  password: ${VENDOR_PASSWORD}`);

	if (process.env.VENDOR_PASSWORD === undefined) {
		console.log(
			"\nIMPORTANT: this is the built-in development password. Set VENDOR_PASSWORD and " +
				"re-run, or change it from the API, before this reaches a real deployment."
		);
	}
}

seedVendor()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error("Vendor seed failed:", error);
		process.exit(1);
	});
