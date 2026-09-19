import { eq } from "drizzle-orm";

import { hashPassword } from "@/lib/auth";

import { db } from "./index";
import { users } from "./schema";
import { ensureDemoTenant, ensureVendorTenant } from "./seedTenants";

// Default admin credentials - CHANGE THESE IN PRODUCTION!
const ADMIN_PHONE = "+998900000000";
const ADMIN_PASSWORD = "admin123";

async function seed() {
	console.log("Seeding database...");

	// The tenants first: every row below belongs to one, and `db:reset` truncates
	// this table too. Both are idempotent.
	await ensureVendorTenant();
	const tenantId = await ensureDemoTenant();

	const existingSupervisor = await db.query.users.findFirst({
		where: eq(users.role, "supervisor"),
	});

	if (existingSupervisor) {
		console.log("Supervisor already exists, skipping seed");
		return;
	}

	const passwordHash = await hashPassword(ADMIN_PASSWORD);

	await db.insert(users).values({
		tenantId,
		phone: ADMIN_PHONE,
		passwordHash,
		role: "supervisor",
		isActive: true,
	});

	console.log("Admin user created successfully!");
	console.log(`Phone: ${ADMIN_PHONE}`);
	console.log(`Password: ${ADMIN_PASSWORD}`);
	console.log("\nIMPORTANT: Change the default password after first login!");
}

seed()
	.then(() => {
		console.log("Seed completed");
		process.exit(0);
	})
	.catch((error) => {
		console.error("Seed failed:", error);
		process.exit(1);
	});
