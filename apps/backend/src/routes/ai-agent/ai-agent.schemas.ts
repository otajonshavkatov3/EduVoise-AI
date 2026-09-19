/**
 * Validation for the business profile the AI agent answers as.
 *
 * Everything the agent says about a business comes from this profile and from
 * the knowledge base, so this file is where a bad configuration is stopped. The
 * rules that matter are not cosmetic:
 *
 *   - ticketCategories may not be empty. The agent must choose a category when
 *     it files a ticket, and an empty list silently falls back to the generic
 *     municipal-era set in DEFAULT_PROFILE, which is wrong for a clinic.
 *   - transferExtensions must look like extensions. "call Aziz" is not dialable,
 *     and the failure would only surface mid-call.
 *   - businessHours must match the exact shape isWithinBusinessHours() reads.
 *     A typo like "monday" instead of "mon" would leave the day unconfigured and
 *     the line quietly open all night, so unknown day keys are rejected loudly.
 */
import { z } from "@hono/zod-openapi";

import { unknownAnswerPolicy } from "@/db/schema";
import { uuidSchema } from "@/lib";

export const unknownPolicyEnum = z.enum(unknownAnswerPolicy).openapi({
	description:
		"Bilim bazasida javob topilmaganda: transfer — odamga uzatish, take_message — savol va telefonni yozib olish, say_unknown — bilmasligini aytish",
	example: "transfer",
});

/** BCP-47 ga yaqin qisqa kod: "uz", "ru", "en-US". Ustun varchar(10). */
const languageSchema = z
	.string()
	.trim()
	.regex(/^[a-z]{2}(-[a-zA-Z]{2,4})?$/, "Til kodi 'uz' yoki 'en-US' ko'rinishida bo'lishi kerak")
	.max(10)
	.openapi({ example: "uz" });

/**
 * Asterisk ichki raqamlari — asterisk.schemas.ts dagi bilan bir xil qoida
 * (raqamlardan iborat, 2..10 belgi; sip_extensions.extension varchar(10)).
 */
const extensionSchema = z
	.string()
	.trim()
	.regex(/^\d{2,10}$/, "Ichki raqam faqat raqamlardan iborat bo'lishi kerak (masalan 101)")
	.openapi({ example: "101" });

const ticketCategorySchema = z.string().trim().min(1).max(60);

/** "HH:MM", 24 soatlik. Nol bilan to'ldirilgani muhim — solishtirish satr bo'yicha ketadi. */
const timeOfDaySchema = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Vaqt HH:MM ko'rinishida bo'lishi kerak")
	.openapi({ example: "09:00" });

const timeRangeSchema = z
	.tuple([timeOfDaySchema, timeOfDaySchema])
	.refine(([from, to]) => from < to, {
		message: "Interval boshlanishi tugashidan kichik bo'lishi kerak",
	});

/**
 * Bir kundagi intervallar. Bo'sh massiv — o'sha kun yopiq (isWithinBusinessHours
 * shunday o'qiydi), kalit umuman bo'lmasa — kun sozlanmagan va ochiq deb olinadi.
 */
const dayRangesSchema = z.array(timeRangeSchema).max(4);

const businessDaysSchema = z
	.strictObject({
		mon: dayRangesSchema.optional(),
		tue: dayRangesSchema.optional(),
		wed: dayRangesSchema.optional(),
		thu: dayRangesSchema.optional(),
		fri: dayRangesSchema.optional(),
		sat: dayRangesSchema.optional(),
		sun: dayRangesSchema.optional(),
	})
	.openapi("AiAgentBusinessDays");

function isValidTimeZone(tz: string): boolean {
	try {
		// Noma'lum zona uchun RangeError tashlaydi — qo'shimcha kutubxonasiz
		// yagona ishonchli tekshiruv.
		return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone.length > 0;
	} catch {
		return false;
	}
}

export const BusinessHoursSchema = z
	.strictObject({
		/**
		 * Ma'lumot uchun saqlanadi. isWithinBusinessHours() hozircha server vaqtida
		 * hisoblaydi, shuning uchun bu qiymat hisobga olinmaydi — noto'g'ri
		 * kutilmaslik uchun route tavsifida ham aytilgan.
		 */
		tz: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.refine(isValidTimeZone, { message: "Vaqt mintaqasi noma'lum (masalan Asia/Tashkent)" })
			.optional(),
		days: businessDaysSchema.refine((days) => Object.keys(days).length > 0, {
			message: "Kamida bitta kun ko'rsatilishi kerak",
		}),
	})
	.openapi("AiAgentBusinessHours", {
		example: { tz: "Asia/Tashkent", days: { mon: [["09:00", "18:00"]] } },
	});

/** Chiqishda saqlangan qiymat qanday bo'lsa shunday beriladi (eski yozuvlar ham bor). */
const businessHoursOutSchema = z.record(z.string(), z.unknown()).nullable();

export const AgentProfileItemSchema = z
	.object({
		id: uuidSchema,
		businessName: z.string(),
		industry: z.string().nullable(),
		businessDescription: z.string().nullable(),
		language: z.string(),
		additionalLanguages: z.array(z.string()),
		voice: z.string(),
		greeting: z.string().nullable(),
		recordingNotice: z.string().nullable(),
		customInstructions: z.string().nullable(),
		ticketCategories: z.array(z.string()),
		unknownPolicy: unknownPolicyEnum,
		transferExtensions: z.array(z.string()),
		businessHours: businessHoursOutSchema,
		afterHoursMessage: z.string().nullable(),
		maxCallSeconds: z.number().int(),
		silenceHangupMs: z.number().int(),
		/** Aynan shu profil qo'ng'iroqlarga javob beradi. Bir vaqtda faqat bittasi. */
		isActive: z.boolean(),
		/** Shu profilga bog'langan bilim bazasi yozuvlari soni. */
		knowledgeEntryCount: z.number().int(),
		activeKnowledgeEntryCount: z.number().int(),
		createdBy: uuidSchema.nullable(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.openapi("AiAgentProfileItem");

export const AgentProfileDetailSchema = AgentProfileItemSchema.extend({
	/** businessHours bo'yicha hozir ish vaqti ekanligi (sozlanmagan bo'lsa — true). */
	isOpenNow: z.boolean(),
}).openapi("AiAgentProfileDetail");

export const CreateBodySchema = z
	.object({
		businessName: z.string().trim().min(1).max(150),
		industry: z.string().trim().min(1).max(100).optional(),
		businessDescription: z.string().trim().min(1).max(4000).optional(),
		language: languageSchema.optional(),
		additionalLanguages: z.array(languageSchema).max(5).optional(),
		voice: z.string().trim().min(1).max(50).optional(),
		greeting: z.string().trim().min(1).max(1000).optional(),
		recordingNotice: z.string().trim().min(1).max(1000).optional(),
		customInstructions: z.string().trim().min(1).max(4000).optional(),
		ticketCategories: z.array(ticketCategorySchema).min(1).max(30).optional(),
		unknownPolicy: unknownPolicyEnum.optional(),
		transferExtensions: z.array(extensionSchema).max(10).optional(),
		businessHours: BusinessHoursSchema.optional(),
		afterHoursMessage: z.string().trim().min(1).max(1000).optional(),
		maxCallSeconds: z.number().int().min(60).max(7200).optional(),
		silenceHangupMs: z.number().int().min(3000).max(120_000).optional(),
	})
	.openapi("AiAgentProfileCreateBody");

export const UpdateBodySchema = z
	.object({
		businessName: z.string().trim().min(1).max(150).optional(),
		industry: z.string().trim().min(1).max(100).nullable().optional(),
		businessDescription: z.string().trim().min(1).max(4000).nullable().optional(),
		language: languageSchema.optional(),
		additionalLanguages: z.array(languageSchema).max(5).optional(),
		voice: z.string().trim().min(1).max(50).optional(),
		greeting: z.string().trim().min(1).max(1000).nullable().optional(),
		recordingNotice: z.string().trim().min(1).max(1000).nullable().optional(),
		customInstructions: z.string().trim().min(1).max(4000).nullable().optional(),
		/** Bo'sh massiv qabul qilinmaydi: agent ticket uchun kategoriya tanlashi shart. */
		ticketCategories: z.array(ticketCategorySchema).min(1).max(30).optional(),
		unknownPolicy: unknownPolicyEnum.optional(),
		transferExtensions: z.array(extensionSchema).max(10).optional(),
		businessHours: BusinessHoursSchema.nullable().optional(),
		afterHoursMessage: z.string().trim().min(1).max(1000).nullable().optional(),
		maxCallSeconds: z.number().int().min(60).max(7200).optional(),
		silenceHangupMs: z.number().int().min(3000).max(120_000).optional(),
	})
	.refine((body) => Object.keys(body).length > 0, {
		message: "Kamida bitta maydon yuborilishi kerak",
	})
	.openapi("AiAgentProfileUpdateBody");

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(AgentProfileItemSchema),
		/** Qulaylik uchun: qaysi profil hozir jonli ekanini alohida qidirish shart emas. */
		activeProfileId: uuidSchema.nullable(),
		total: z.number().int(),
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: AgentProfileItemSchema,
});

export const DetailOutSchema = z.object({
	success: z.literal(true),
	data: AgentProfileDetailSchema,
});

export const DeleteOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		message: z.string(),
		/** Profil bilan birga o'chgan bilim bazasi yozuvlari soni (cascade). */
		deletedKnowledgeEntries: z.number().int(),
	}),
});

export type AgentProfileItem = z.infer<typeof AgentProfileItemSchema>;
export type CreateBody = z.infer<typeof CreateBodySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
