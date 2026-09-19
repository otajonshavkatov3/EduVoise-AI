/**
 * Seeds the sip_extensions mirror table from the PJSIP endpoints that actually
 * exist in asterisk/etc/pjsip.conf.template.
 *
 * Asterisk remains the authority on SIP configuration; this table exists so the
 * dashboard can list extensions and attach them to operators without hitting
 * AMI on every page load. Re-runnable: extension is unique, so this upserts.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "./index";
import { operatorProfiles, sipExtensions, users } from "./schema";
import { requireDemoTenant } from "./seedTenants";

const EXTENSIONS = [
	{ extension: "101", displayName: "Operator 101", kind: "sip" as const },
	{ extension: "102", displayName: "Operator 102", kind: "sip" as const },
	{ extension: "103", displayName: "Operator 103", kind: "sip" as const },
	{ extension: "104", displayName: "Operator 104", kind: "sip" as const },
	// Not a real PJSIP endpoint: 900 is the dialplan extension that hands the
	// caller to Stasis(callcenter-ai). Recorded here so the dashboard can show
	// the AI as a callable destination alongside the human ones.
	{ extension: "900", displayName: "AI Agent", kind: "ai" as const },
];

async function seedSipExtensions() {
	console.log("Seeding sip_extensions...");

	// Extensions are per tenant now: "101" is one customer's operator code.
	const tenantId = await requireDemoTenant();

	for (const ext of EXTENSIONS) {
		await db
			.insert(sipExtensions)
			.values({
				tenantId,
				extension: ext.extension,
				displayName: ext.displayName,
				kind: ext.kind,
				isEnabled: true,
			})
			.onConflictDoUpdate({
				target: [sipExtensions.tenantId, sipExtensions.extension],
				set: {
					displayName: ext.displayName,
					kind: ext.kind,
					updatedAt: sql`now()`,
				},
			});
		console.log(`  upserted ${ext.extension} (${ext.kind}) - ${ext.displayName}`);
	}

	const rows = await db.select({ n: sql<number>`count(*)::int` }).from(sipExtensions);
	console.log(`sip_extensions now has ${rows[0]?.n ?? 0} rows`);

	await linkFirstOperator();
}

/**
 * Dev convenience: give extension 101 an operator_profiles row.
 *
 * Without one, a transferred call has nobody to attribute it to and
 * `calls.operator_id` stays null - the transfer still connects, but the call
 * never shows up under an operator in the dashboard. In production you create
 * operators through the UI and assign their extensions there; this mirrors what
 * db:seed already does for the default admin so the platform is demonstrable
 * immediately after a fresh install.
 */
async function linkFirstOperator(): Promise<void> {
	const tenantId = await requireDemoTenant();
	const existing = await db.query.operatorProfiles.findFirst({
		where: and(
			eq(operatorProfiles.tenantId, tenantId),
			eq(operatorProfiles.extension, "101"),
			eq(operatorProfiles.isDeleted, false)
		),
		columns: { id: true },
	});

	if (existing) {
		await db
			.update(sipExtensions)
			.set({ operatorProfileId: existing.id, updatedAt: sql`now()` })
			.where(eq(sipExtensions.extension, "101"));
		console.log("extension 101 already has an operator profile - relinked");
		return;
	}

	const supervisor = await db.query.users.findFirst({
		where: and(eq(users.role, "supervisor"), eq(users.isDeleted, false)),
		columns: { id: true, phone: true },
	});

	if (!supervisor) {
		console.log("no supervisor user found - run db:seed first, skipping operator link");
		return;
	}

	// operator_profiles has a unique index on user_id, so a supervisor who
	// already has a profile (on some other extension) must not get a second one.
	const already = await db.query.operatorProfiles.findFirst({
		where: eq(operatorProfiles.userId, supervisor.id),
		columns: { id: true, extension: true },
	});

	if (already) {
		console.log(
			`supervisor already owns extension ${already.extension} - leaving it, 101 stays unassigned`
		);
		return;
	}

	const [profile] = await db
		.insert(operatorProfiles)
		.values({ tenantId, userId: supervisor.id, extension: "101", currentStatus: "online" })
		.returning({ id: operatorProfiles.id });

	if (!profile) {
		console.log("failed to create the operator profile");
		return;
	}

	await db
		.update(sipExtensions)
		.set({ operatorProfileId: profile.id, updatedAt: sql`now()` })
		.where(eq(sipExtensions.extension, "101"));

	console.log(`created operator profile for ${supervisor.phone} on extension 101 (status online)`);
}

seedSipExtensions()
	.then(() => {
		console.log("Seed completed");
		process.exit(0);
	})
	.catch((error) => {
		console.error("Seed failed:", error);
		process.exit(1);
	});
