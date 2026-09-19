/**
 * Switches the demo tenant's AI agent to the Oliy ta'lim, fan va innovatsiyalar
 * vazirligi appeals line: its profile and knowledge base
 * (./seed-data/ministry-*.ts).
 *
 * Adds a profile next to AviLab's rather than overwriting it, and makes it the
 * active one - `bun run db:seed:ai` switches back. Operators and SIP extensions
 * are untouched: they are the people and phones answering, not the agent's
 * identity.
 *
 * Re-runnable, with the same keys as seedAiAgent.ts: the profile is upserted by
 * name and each knowledge entry by the opening phrase of its question. The
 * running backend picks the change up within its 30 s profile cache.
 */
import { and, eq, ne, sql } from "drizzle-orm";

import { invalidateAgentProfileCache } from "@/lib/ai-agent";
import type { TenantId } from "@/lib/tenancy";
import { db } from "./index";
import { aiAgentProfiles, knowledgeBaseEntries } from "./schema";
import { MINISTRY_KNOWLEDGE } from "./seed-data/ministry-knowledge";
import { MINISTRY_PROFILE } from "./seed-data/ministry-profile";
import { requireDemoTenant } from "./seedTenants";

async function seedProfile(tenantId: TenantId): Promise<string> {
	const existing = await db.query.aiAgentProfiles.findFirst({
		where: and(
			eq(aiAgentProfiles.tenantId, tenantId),
			eq(aiAgentProfiles.businessName, MINISTRY_PROFILE.businessName)
		),
		columns: { id: true },
	});

	const values = {
		businessName: MINISTRY_PROFILE.businessName,
		industry: MINISTRY_PROFILE.industry,
		businessDescription: MINISTRY_PROFILE.businessDescription,
		language: MINISTRY_PROFILE.language,
		additionalLanguages: [...MINISTRY_PROFILE.additionalLanguages],
		voice: MINISTRY_PROFILE.voice,
		greeting: MINISTRY_PROFILE.greeting,
		recordingNotice: MINISTRY_PROFILE.recordingNotice,
		customInstructions: MINISTRY_PROFILE.customInstructions,
		ticketCategories: [...MINISTRY_PROFILE.ticketCategories],
		unknownPolicy: MINISTRY_PROFILE.unknownPolicy,
		transferExtensions: [...MINISTRY_PROFILE.transferExtensions],
		businessHours: MINISTRY_PROFILE.businessHours,
		afterHoursMessage: MINISTRY_PROFILE.afterHoursMessage,
		maxCallSeconds: MINISTRY_PROFILE.maxCallSeconds,
		silenceHangupMs: MINISTRY_PROFILE.silenceHangupMs,
		isActive: true,
		updatedAt: sql`now()`,
	};

	// One transaction: the partial unique index allows exactly one active profile
	// per tenant, so deactivating the others and activating this one is one step.
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
	console.log(`  profile: ${MINISTRY_PROFILE.businessName} (${id}) - active`);

	return id;
}

/** Same identity rule as seedAiAgent.ts: the opening phrase of the question. */
function entryKey(question: string): string {
	return question.split(/[?.!]/)[0].trim().toLowerCase();
}

async function seedKnowledge(tenantId: TenantId, profileId: string): Promise<void> {
	let created = 0;
	let updated = 0;

	const present = await db.query.knowledgeBaseEntries.findMany({
		where: eq(knowledgeBaseEntries.agentProfileId, profileId),
		columns: { id: true, question: true },
	});
	const byKey = new Map(present.map((row) => [entryKey(row.question), row]));

	for (const entry of MINISTRY_KNOWLEDGE) {
		const existing = byKey.get(entryKey(entry.question));

		if (existing) {
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
			updated++;
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

	console.log(`  knowledge base: ${created} created, ${updated} updated`);
}

async function seedMinistry(): Promise<void> {
	console.log(`Switching the demo tenant's AI agent to: ${MINISTRY_PROFILE.businessName}`);

	const tenantId = await requireDemoTenant();
	const profileId = await seedProfile(tenantId);

	await seedKnowledge(tenantId, profileId);

	console.log("\nDone. Dial 900 and ask about an appeal, admission or a transfer.");
	console.log("Edit it in the dashboard: AI yordamchi -> Biznes profili / Bilim bazasi");
	console.log("Switch back to AviLab: bun run db:seed:ai");
}

seedMinistry()
	.then(() => {
		console.log("Seed completed");
		process.exit(0);
	})
	.catch((error) => {
		console.error("Seed failed:", error);
		process.exit(1);
	});
