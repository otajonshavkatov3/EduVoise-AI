/**
 * Seeds the demo tenant: AviLab's agent profile, its team and its knowledge base.
 *
 * Without an active profile the agent falls back to cautious defaults - safe, but
 * the dashboard shows an empty form and the agent cannot answer a single business
 * question. A four-line placeholder knowledge base was barely better: it proved
 * nothing about whether the search, the ticket categories or the "never invent a
 * fact" rule actually hold up on a real business.
 *
 * So this seeds a whole one. Content lives in ./seed-data/avilab-*.ts and comes
 * from AviLab's own site; anything the site does not state is deliberately absent
 * rather than guessed.
 *
 * Re-runnable. The profile is upserted by name, operators by extension, and each
 * knowledge entry by the opening phrase of its question, so running it twice
 * changes nothing - and adding a new phrasing to an existing entry updates that
 * entry instead of leaving a stale duplicate behind to be served forever.
 */
import { and, eq, ne, sql } from "drizzle-orm";

import { invalidateAgentProfileCache } from "@/lib/ai-agent";
import { hashPassword } from "@/lib/auth";
import type { TenantId } from "@/lib/tenancy";
import { db } from "./index";
import { aiAgentProfiles, knowledgeBaseEntries, operatorProfiles, users } from "./schema";
import { AVILAB_KNOWLEDGE } from "./seed-data/avilab-knowledge";
import { AVILAB_OPERATORS, AVILAB_PROFILE } from "./seed-data/avilab-profile";
import { requireDemoTenant } from "./seedTenants";

/** Shared by every seeded operator login. Development only. */
const OPERATOR_PASSWORD = "avilab123";

async function seedProfile(tenantId: TenantId): Promise<string> {
	const existing = await db.query.aiAgentProfiles.findFirst({
		where: and(
			eq(aiAgentProfiles.tenantId, tenantId),
			eq(aiAgentProfiles.businessName, AVILAB_PROFILE.businessName)
		),
		columns: { id: true },
	});

	const values = {
		businessName: AVILAB_PROFILE.businessName,
		industry: AVILAB_PROFILE.industry,
		businessDescription: AVILAB_PROFILE.businessDescription,
		language: AVILAB_PROFILE.language,
		additionalLanguages: [...AVILAB_PROFILE.additionalLanguages],
		voice: AVILAB_PROFILE.voice,
		greeting: AVILAB_PROFILE.greeting,
		recordingNotice: AVILAB_PROFILE.recordingNotice,
		customInstructions: AVILAB_PROFILE.customInstructions,
		ticketCategories: [...AVILAB_PROFILE.ticketCategories],
		unknownPolicy: AVILAB_PROFILE.unknownPolicy,
		transferExtensions: [...AVILAB_PROFILE.transferExtensions],
		businessHours: AVILAB_PROFILE.businessHours,
		afterHoursMessage: AVILAB_PROFILE.afterHoursMessage,
		maxCallSeconds: AVILAB_PROFILE.maxCallSeconds,
		silenceHangupMs: AVILAB_PROFILE.silenceHangupMs,
		isActive: true,
		updatedAt: sql`now()`,
	};

	// One transaction: a partial unique index allows exactly one active profile, so
	// deactivating the others and activating this one cannot be two separate steps.
	const id = await db.transaction(async (tx) => {
		if (existing) {
			await tx
				.update(aiAgentProfiles)
				.set({ isActive: false })
				.where(and(eq(aiAgentProfiles.tenantId, tenantId), ne(aiAgentProfiles.id, existing.id)));
			await tx.update(aiAgentProfiles).set(values).where(eq(aiAgentProfiles.id, existing.id));
			return existing.id;
		}

		await tx
			.update(aiAgentProfiles)
			.set({ isActive: false })
			.where(eq(aiAgentProfiles.tenantId, tenantId));
		const [row] = await tx
			.insert(aiAgentProfiles)
			.values({ ...values, tenantId })
			.returning({ id: aiAgentProfiles.id });

		return row.id;
	});

	invalidateAgentProfileCache();
	console.log(`  profile: ${AVILAB_PROFILE.businessName} (${id}) - active`);

	return id;
}

async function seedOperators(tenantId: TenantId): Promise<void> {
	const passwordHash = await hashPassword(OPERATOR_PASSWORD);
	let created = 0;
	let updated = 0;

	for (const operator of AVILAB_OPERATORS) {
		const existingUser = await db.query.users.findFirst({
			where: eq(users.phone, operator.phone),
			columns: { id: true },
		});

		let userId = existingUser?.id;

		if (userId === undefined) {
			const [row] = await db
				.insert(users)
				.values({
					tenantId,
					phone: operator.phone,
					username: operator.fullName,
					email: operator.email,
					passwordHash,
					role: operator.userRole,
					isActive: true,
				})
				.returning({ id: users.id });

			userId = row.id;
			created++;
		} else {
			await db
				.update(users)
				.set({ username: operator.fullName, email: operator.email, role: operator.userRole })
				.where(eq(users.id, userId));
			updated++;
		}

		await db
			.insert(operatorProfiles)
			.values({ tenantId, userId, extension: operator.extension })
			.onConflictDoUpdate({
				// The uniqueness rule is (tenant_id, extension) now: 101 belongs to one
				// customer, and another customer's 101 is a different operator.
				target: [operatorProfiles.tenantId, operatorProfiles.extension],
				set: { userId, isDeleted: false, deletedAt: null },
			});

		console.log(`  operator ${operator.extension}: ${operator.fullName} - ${operator.role}`);
	}

	console.log(`  users: ${created} created, ${updated} updated (parol: ${OPERATOR_PASSWORD})`);
}

/**
 * A knowledge entry's identity across edits.
 *
 * The `question` column doubles as the list of phrasings search matches on, so
 * it grows every time someone teaches the agent another way a caller asks the
 * same thing. Keyed on the whole string, adding a phrasing would insert a
 * SECOND row and leave the old one active - two near-identical answers
 * competing in every search. The opening phrase is what stays put, so that is
 * the key; new phrasings are appended after it.
 */
function entryKey(question: string): string {
	return question.split(/[?.!]/)[0].trim().toLowerCase();
}

async function seedKnowledge(tenantId: TenantId, profileId: string): Promise<void> {
	let created = 0;
	let updated = 0;
	let rephrased = 0;

	const present = await db.query.knowledgeBaseEntries.findMany({
		where: eq(knowledgeBaseEntries.agentProfileId, profileId),
		columns: { id: true, question: true },
	});
	const byKey = new Map(present.map((row) => [entryKey(row.question), row]));

	for (const entry of AVILAB_KNOWLEDGE) {
		const existing = byKey.get(entryKey(entry.question));

		if (existing) {
			// Update rather than skip: re-running after an edit to the source content
			// should actually change what the agent says.
			await db
				.update(knowledgeBaseEntries)
				.set({
					question: entry.question,
					answer: entry.answer,
					tags: [...entry.tags],
					priority: entry.priority,
					isActive: true,
					updatedAt: sql`now()`,
				})
				.where(eq(knowledgeBaseEntries.id, existing.id));

			if (existing.question === entry.question) {
				updated++;
			} else {
				rephrased++;
			}
			continue;
		}

		await db.insert(knowledgeBaseEntries).values({
			tenantId,
			agentProfileId: profileId,
			question: entry.question,
			answer: entry.answer,
			tags: [...entry.tags],
			priority: entry.priority,
			isActive: true,
		});
		created++;
	}

	// Entries the seed does not own are left alone - deleting them would throw away
	// whatever the business added through the dashboard. But a stale row from an
	// earlier version of this file keeps being served, so it gets named rather than
	// silently kept. `bun run db:demo` starts from an empty database and avoids it.
	const seeded = new Set(AVILAB_KNOWLEDGE.map((entry) => entryKey(entry.question)));
	const foreign = present.filter((row) => !seeded.has(entryKey(row.question)));

	console.log(
		`  knowledge base: ${created} created, ${updated} updated, ${rephrased} rephrased in place`
	);

	if (foreign.length > 0) {
		console.log(`  ${foreign.length} entries are not from this seed and were left untouched:`);
		for (const row of foreign) {
			console.log(`    - ${row.question.slice(0, 70)}`);
		}
	}
}

async function seedAviLab(): Promise<void> {
	console.log(`Seeding the demo tenant: ${AVILAB_PROFILE.businessName}`);

	// The customer these rows belong to. It must already exist (db:seed creates it):
	// a demo seed that invented a tenant would produce data nobody can log in to.
	const tenantId = await requireDemoTenant();
	const profileId = await seedProfile(tenantId);

	await seedOperators(tenantId);
	await seedKnowledge(tenantId, profileId);

	console.log("\nDone. Dial 900 and ask about a service, a project or the team.");
	console.log("Edit it in the dashboard: AI yordamchi -> Biznes profili / Bilim bazasi");
	console.log("The agent states ONLY what the knowledge base contains - it never invents facts.");
}

seedAviLab()
	.then(() => {
		console.log("Seed completed");
		process.exit(0);
	})
	.catch((error) => {
		console.error("Seed failed:", error);
		process.exit(1);
	});
