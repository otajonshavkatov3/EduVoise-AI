/**
 * Validation for outbound campaigns.
 *
 * The limits here are not decoration: every one of them is a bound on how many
 * strangers this platform may ring, how often, and at what hour. `purpose` is
 * required and short because it is read out loud in one breath at the start of a
 * call the person did not ask for; the window bounds mirror a CHECK constraint on
 * the table, so a value that gets past the API is still refused by Postgres.
 */
import { z } from "@hono/zod-openapi";

import {
	campaignKindEnum,
	campaignLeadStatusEnum,
	campaignOutcomeEnum,
	campaignStatusEnum,
	dncSourceEnum,
} from "@/db/schema";
import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";
import { EARLIEST_CALL_TIME, HH_MM_PATTERN, LATEST_CALL_TIME } from "@/lib/campaigns";

// ===========================================
// Primitives
// ===========================================

/** Query params arrive as strings, so boolean flags are "true"/"false". */
const boolQueryEnum = z.enum(["true", "false"]);

const campaignStatus = z.enum(campaignStatusEnum.enumValues);
const campaignKind = z.enum(campaignKindEnum.enumValues);
const leadStatus = z.enum(campaignLeadStatusEnum.enumValues);
const campaignOutcome = z.enum(campaignOutcomeEnum.enumValues);
const dncSource = z.enum(dncSourceEnum.enumValues);

const nameSchema = z.string().trim().min(3).max(150);

/**
 * The sentence the person hears first.
 *
 * Min 10 characters so "test" cannot become the stated reason for ringing somebody;
 * max 400 because the agent has to say it in one breath before anything else, and a
 * paragraph would be read as a script instead of a reason.
 */
const purposeSchema = z.string().trim().min(10).max(400);

/** Extra instructions for this campaign only. Bounded: it is prompt text, billed per call. */
const scriptSchema = z.string().trim().max(4000);

const timeOfDaySchema = z
	.string()
	.trim()
	.regex(HH_MM_PATTERN, "Vaqt HH:MM ko'rinishida yozilishi kerak, masalan 09:00")
	.refine((value) => value >= EARLIEST_CALL_TIME && value <= LATEST_CALL_TIME, {
		message: `Qo'ng'iroq vaqti ${EARLIEST_CALL_TIME} va ${LATEST_CALL_TIME} orasida bo'lishi kerak`,
	});

const maxAttemptsSchema = z.number().int().min(1).max(10);
const retryDelaySchema = z.number().int().min(5).max(1440);
const concurrencySchema = z.number().int().min(1).max(20);

const phoneInputSchema = z.string().trim().min(3).max(40);
const leadNameSchema = z.string().trim().max(150);
const leadNoteSchema = z.string().trim().max(1000);
const variablesSchema = z.record(z.string().trim().min(1).max(40), z.string().trim().max(200));

/** One import call. Above this a list is a data migration, not a paste. */
export const MAX_IMPORT_ROWS = 1000;

/** How long a lead may sit in `calling` before the UI is allowed to call it stuck. */
export const STALE_CALLING_MINUTES = 10;

// ===========================================
// Campaign
// ===========================================

export const CampaignSchema = z
	.object({
		id: uuidSchema,
		name: z.string(),
		kind: campaignKind,
		purpose: z.string(),
		script: z.string().nullable(),
		agentProfileId: uuidSchema.nullable(),
		/** Null — aktiv profil ishlatiladi (qo'ng'iroq vaqtida tanlanadi). */
		agentProfileName: z.string().nullable(),
		status: campaignStatus,
		callWindowStart: z.string(),
		callWindowEnd: z.string(),
		maxAttempts: z.number().int(),
		retryDelayMinutes: z.number().int(),
		concurrency: z.number().int(),
		createdBy: uuidSchema.nullable(),
		createdByName: z.string().nullable(),
		startedBy: uuidSchema.nullable(),
		startedByName: z.string().nullable(),
		startedAt: z.string().datetime().nullable(),
		pausedAt: z.string().datetime().nullable(),
		endedAt: z.string().datetime().nullable(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		/** Ro'yxatdagi umumiy raqamlar soni va hali qo'ng'iroq kutayotganlar. */
		leadCount: z.number().int(),
		pendingCount: z.number().int(),
		/** UI shu ro'yxat bo'yicha tugmalarni ko'rsatadi — bekor qilingan holatda bo'sh. */
		availableActions: z.array(z.enum(["start", "pause", "cancel"])),
	})
	.openapi("Campaign");

export const ListQuerySchema = z
	.object({
		status: campaignStatus.optional().openapi({
			param: { name: "status", in: "query", description: "Holat bo'yicha filtr" },
		}),
		kind: campaignKind.optional().openapi({
			param: { name: "kind", in: "query", description: "Kampaniya turi bo'yicha filtr" },
		}),
		q: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.optional()
			.openapi({
				param: { name: "q", in: "query", description: "Nom va maqsad matni bo'yicha izlash" },
			}),
	})
	.merge(PaginationQuerySchema);

export const CreateBodySchema = z
	.object({
		name: nameSchema,
		kind: campaignKind.optional(),
		purpose: purposeSchema,
		script: scriptSchema.optional(),
		agentProfileId: uuidSchema.optional(),
		callWindowStart: timeOfDaySchema.optional(),
		callWindowEnd: timeOfDaySchema.optional(),
		maxAttempts: maxAttemptsSchema.optional(),
		retryDelayMinutes: retryDelaySchema.optional(),
		concurrency: concurrencySchema.optional(),
	})
	.refine(
		(body) =>
			body.callWindowStart === undefined ||
			body.callWindowEnd === undefined ||
			body.callWindowStart < body.callWindowEnd,
		{
			message: "Qo'ng'iroq oynasining boshlanishi tugashidan oldin bo'lishi kerak",
			path: ["callWindowEnd"],
		}
	)
	.openapi("CampaignCreateBody");

export const UpdateBodySchema = z
	.object({
		name: nameSchema.optional(),
		kind: campaignKind.optional(),
		purpose: purposeSchema.optional(),
		script: scriptSchema.nullable().optional(),
		agentProfileId: uuidSchema.nullable().optional(),
		callWindowStart: timeOfDaySchema.optional(),
		callWindowEnd: timeOfDaySchema.optional(),
		maxAttempts: maxAttemptsSchema.optional(),
		retryDelayMinutes: retryDelaySchema.optional(),
		concurrency: concurrencySchema.optional(),
	})
	.refine((body) => Object.keys(body).length > 0, {
		message: "Kamida bitta maydon yuborilishi kerak",
	})
	.openapi("CampaignUpdateBody");

// ===========================================
// Leads
// ===========================================

export const LeadSchema = z
	.object({
		id: uuidSchema,
		campaignId: uuidSchema,
		/** Saqlangan ko'rinish: faqat sonlar, davlat kodi bilan (998905706507) yoki ichki raqam (201). */
		phoneNumber: z.string(),
		/** Ko'rsatish uchun guruhlangan ko'rinish: +998 90 570 65 07. */
		phoneDisplay: z.string(),
		fullName: z.string().nullable(),
		contactId: uuidSchema.nullable(),
		variables: z.record(z.string(), z.string()),
		status: leadStatus,
		outcome: campaignOutcome.nullable(),
		attempts: z.number().int(),
		lastAttemptAt: z.string().datetime().nullable(),
		nextAttemptAt: z.string().datetime().nullable(),
		/** Oxirgi qo'ng'iroq — /calls/:id kartasida transkript, yozuv va narx bor. */
		callId: uuidSchema.nullable(),
		note: z.string().nullable(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.openapi("CampaignLead");

export const LeadListQuerySchema = z
	.object({
		status: leadStatus.optional().openapi({
			param: { name: "status", in: "query", description: "Navbat holati bo'yicha filtr" },
		}),
		outcome: campaignOutcome.optional().openapi({
			param: { name: "outcome", in: "query", description: "Qo'ng'iroq natijasi bo'yicha filtr" },
		}),
		q: z
			.string()
			.trim()
			.min(1)
			.max(60)
			.optional()
			.openapi({
				param: { name: "q", in: "query", description: "Raqam yoki ism bo'yicha izlash" },
			}),
		hasCall: boolQueryEnum.optional().openapi({
			param: { name: "hasCall", in: "query", description: "true — qo'ng'iroq bo'lganlari" },
		}),
	})
	.merge(PaginationQuerySchema);

export const LeadParamSchema = z.object({
	id: uuidSchema.openapi({ param: { name: "id", in: "path", required: true } }),
	leadId: uuidSchema.openapi({ param: { name: "leadId", in: "path", required: true } }),
});

export const LeadUpdateBodySchema = z
	.object({
		note: leadNoteSchema.nullable().optional(),
		/** Qo'lda qayta qo'ng'iroq qilib natijani yozish uchun. Urinishlar soni oshmaydi. */
		outcome: campaignOutcome.optional(),
		/**
		 * requeue — navbatga qaytarish (natija tozalanadi), skip — bu raqamga umuman
		 * qo'ng'iroq qilinmasin (kampaniya ichida).
		 */
		action: z.enum(["requeue", "skip"]).optional(),
	})
	.refine((body) => Object.keys(body).length > 0, {
		message: "Kamida bitta maydon yuborilishi kerak",
	})
	.openapi("CampaignLeadUpdateBody");

// ===========================================
// Import
// ===========================================

export const ImportBodySchema = z
	.object({
		/** Tayyor qatorlar (masalan boshqa tizimdan). `text` bilan birga yuborilmaydi. */
		rows: z
			.array(
				z.object({
					phone: phoneInputSchema,
					fullName: leadNameSchema.optional(),
					variables: variablesSchema.optional(),
					note: leadNoteSchema.optional(),
				})
			)
			.min(1)
			.max(MAX_IMPORT_ROWS)
			.optional(),
		/** Bir textarea'ga qo'yilgan ro'yxat: CSV, nuqtali vergul yoki tab bilan. */
		text: z.string().min(1).max(500_000).optional(),
	})
	.refine((body) => (body.rows === undefined) !== (body.text === undefined), {
		message: "Faqat bittasini yuboring: `rows` yoki `text`",
	})
	.openapi("CampaignImportBody");

/**
 * Why a row did not become a lead.
 *
 * Machine-readable AND translated, because the UI groups by the code ("14 ta
 * takroriy raqam") and shows the sentence on the row itself.
 */
export const importSkipReasons = [
	"invalid_number",
	"duplicate_in_file",
	"already_in_campaign",
	"do_not_call",
	"insert_failed",
] as const;

export const ImportRowResultSchema = z
	.object({
		/** Yuborilgan ro'yxatdagi o'rin (0 dan) — xatoli qatorni topish uchun. */
		index: z.number().int(),
		/** Matn import qilinganda — asl qator raqami. */
		line: z.number().int().nullable(),
		status: z.enum(["created", "skipped", "failed"]),
		/** Qanday yozilgan bo'lsa shundayligicha. */
		input: z.string(),
		/** Normalizatsiyadan keyingi ko'rinish; noto'g'ri raqamda null. */
		phoneNumber: z.string().nullable(),
		fullName: z.string().nullable(),
		leadId: uuidSchema.nullable(),
		reason: z.enum(importSkipReasons).nullable(),
		/** O'zbekcha izoh — UI shuni qator yonida ko'rsatadi. */
		message: z.string().nullable(),
	})
	.openapi("CampaignImportRowResult");

export const ImportOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		campaignId: uuidSchema,
		submitted: z.number().int(),
		created: z.number().int(),
		skipped: z.number().int(),
		failed: z.number().int(),
		/** Sabab bo'yicha jamlanma: UI shu bilan qisqa xulosa ko'rsatadi. */
		skippedByReason: z.record(z.enum(importSkipReasons), z.number().int()),
		/** Matn import qilinganda aniqlangan ajratgich va sarlavha (bo'lsa). */
		parsed: z
			.object({
				delimiter: z.string(),
				headers: z.array(z.string()).nullable(),
				ignoredLines: z.array(z.number().int()),
				truncated: z.boolean(),
			})
			.nullable(),
		results: z.array(ImportRowResultSchema),
	}),
});

// ===========================================
// Progress
// ===========================================

export const DialingReadinessSchema = z
	.object({
		/** SIP_TRUNK_HOST to'ldirilganmi. false — faqat ichki raqamlar teriladi. */
		trunkConfigured: z.boolean(),
		/** Ro'yxatda tashqi (mobil) raqamlar bormi. */
		hasExternalLeads: z.boolean(),
		/** Ro'yxatda ichki raqamlar (101–104, 201–204) bormi — sinov uchun. */
		hasInternalLeads: z.boolean(),
		/** true — hozir hech bo'lmasa bitta raqamga qo'ng'iroq qilish mumkin. */
		canDial: z.boolean(),
		/** O'zbekcha ogohlantirish; muammo bo'lmasa bo'sh satr. */
		warning: z.string(),
	})
	.openapi("CampaignDialingReadiness");

export const ProgressOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		campaignId: uuidSchema,
		status: campaignStatus,
		leads: z.object({
			total: z.number().int(),
			pending: z.number().int(),
			calling: z.number().int(),
			done: z.number().int(),
			failed: z.number().int(),
			skipped: z.number().int(),
			/** `calling` holatida qotib qolganlar (dialer to'xtab qolgan bo'lsa). */
			stalledCalling: z.number().int(),
		}),
		/** Natijalar kesimi — biznes shu raqamlar bilan ishlaydi. */
		outcomes: z.record(campaignOutcome, z.number().int()),
		attempts: z.object({
			total: z.number().int(),
			withCall: z.number().int(),
		}),
		/**
		 * Xarajat /ai-costs bilan bir xil kodda (lib/ai-cost) hisoblanadi va bazada
		 * saqlanmaydi. Hisoblab bo'lmagan qiymat null (0 emas).
		 */
		spend: z.object({
			/** false — bu rol xarajatni ko'rmaydi (/ai-costs bilan bir xil qoida). */
			visible: z.boolean(),
			sessions: z.number().int().nullable(),
			pricedSessions: z.number().int().nullable(),
			unpricedSessions: z.number().int().nullable(),
			callSeconds: z.number().int().nullable(),
			costUsd: z.number().nullable(),
			costUzs: z.number().nullable(),
			costPerAnsweredUsd: z.number().nullable(),
		}),
		window: z.object({
			start: z.string(),
			end: z.string(),
			timeZone: z.string(),
			now: z.string(),
			openNow: z.boolean(),
			minutesUntilOpen: z.number().int(),
			message: z.string(),
		}),
		/** Liniya tayyorligi — trunk sozlanmagan bo'lsa tashqi raqamlarga qo'ng'iroq ketmaydi. */
		dialing: DialingReadinessSchema,
	}),
});

// ===========================================
// Do-not-call
// ===========================================

export const DncEntrySchema = z
	.object({
		id: uuidSchema,
		phoneNumber: z.string(),
		phoneDisplay: z.string(),
		reason: z.string().nullable(),
		source: dncSource,
		/** O'zbekcha: «qo'ng'iroqda so'radi» / «qo'lda kiritilgan» / «import». */
		sourceLabel: z.string(),
		callId: uuidSchema.nullable(),
		createdBy: uuidSchema.nullable(),
		createdByName: z.string().nullable(),
		/** false — bu yozuvni o'chirib bo'lmaydi (odam o'zi so'ragan). */
		removable: z.boolean(),
		createdAt: z.string().datetime(),
	})
	.openapi("DoNotCallEntry");

export const DncListQuerySchema = z
	.object({
		q: z
			.string()
			.trim()
			.min(1)
			.max(40)
			.optional()
			.openapi({ param: { name: "q", in: "query", description: "Raqam bo'yicha izlash" } }),
		source: dncSource.optional().openapi({
			param: { name: "source", in: "query", description: "Qanday kiritilgani bo'yicha filtr" },
		}),
	})
	.merge(PaginationQuerySchema);

export const DncCreateBodySchema = z
	.object({
		/** Bitta yoki bir nechta raqam. Takrori xatolik emas — bir yozuv bo'lib qoladi. */
		phones: z.array(phoneInputSchema).min(1).max(MAX_IMPORT_ROWS),
		reason: z.string().trim().max(500).optional(),
		/** Bir necha raqam birdan yuborilsa `import`, aks holda `manual`. */
		source: z.enum(["manual", "import"]).optional(),
	})
	.openapi("DoNotCallCreateBody");

export const DncRowResultSchema = z
	.object({
		index: z.number().int(),
		input: z.string(),
		phoneNumber: z.string().nullable(),
		status: z.enum(["created", "existing", "failed"]),
		message: z.string().nullable(),
		/** Shu raqam navbatdan chiqarilgan kampaniya yozuvlari soni. */
		leadsSkipped: z.number().int(),
	})
	.openapi("DoNotCallRowResult");

export const DncCreateOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		created: z.number().int(),
		existing: z.number().int(),
		failed: z.number().int(),
		/** Barcha raqamlar bo'yicha navbatdan chiqarilgan yozuvlar soni. */
		leadsSkipped: z.number().int(),
		results: z.array(DncRowResultSchema),
	}),
});

// ===========================================
// Envelopes
// ===========================================

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(CampaignSchema),
		meta: PaginationMetaSchema,
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: CampaignSchema,
});

export const StartOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		campaign: CampaignSchema,
		dialing: DialingReadinessSchema,
		window: z.object({
			openNow: z.boolean(),
			message: z.string(),
		}),
		/** Ishga tushirishda e'tibor berilishi kerak bo'lgan holatlar (bo'sh bo'lishi mumkin). */
		warnings: z.array(z.string()),
	}),
});

export const LeadListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(LeadSchema),
		meta: PaginationMetaSchema,
	}),
});

export const LeadOneOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		lead: LeadSchema,
		attempts: z.array(
			z.object({
				id: uuidSchema,
				attemptNo: z.number().int(),
				callId: uuidSchema.nullable(),
				outcome: campaignOutcome.nullable(),
				detail: z.string().nullable(),
				dialedAt: z.string().datetime(),
				endedAt: z.string().datetime().nullable(),
				/** Qo'ng'iroq davomiyligi (sekund) — `calls` jadvalidan. */
				callDuration: z.number().int().nullable(),
			})
		),
	}),
});

/** PATCH on a lead answers with the lead alone - the attempt list has not changed. */
export const LeadUpdateOutSchema = z.object({
	success: z.literal(true),
	data: LeadSchema,
});

export const DncListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(DncEntrySchema),
		meta: PaginationMetaSchema,
	}),
});

export const DeleteOutSchema = z.object({
	success: z.literal(true),
	data: z.object({ message: z.string() }),
});

export type CampaignItem = z.infer<typeof CampaignSchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type CreateBody = z.infer<typeof CreateBodySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
export type LeadItem = z.infer<typeof LeadSchema>;
export type LeadListQuery = z.infer<typeof LeadListQuerySchema>;
export type LeadUpdateBody = z.infer<typeof LeadUpdateBodySchema>;
export type ImportBody = z.infer<typeof ImportBodySchema>;
export type ImportRowResult = z.infer<typeof ImportRowResultSchema>;
export type ImportSkipReason = (typeof importSkipReasons)[number];
export type DialingReadiness = z.infer<typeof DialingReadinessSchema>;
export type DncEntryItem = z.infer<typeof DncEntrySchema>;
export type DncListQuery = z.infer<typeof DncListQuerySchema>;
export type DncCreateBody = z.infer<typeof DncCreateBodySchema>;
export type DncRowResult = z.infer<typeof DncRowResultSchema>;
