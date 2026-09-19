/**
 * Validation for the knowledge base — the only thing the AI agent is allowed to
 * assert as fact on a recorded line.
 *
 * The limits here are not arbitrary: a question is what a caller might ask (one
 * sentence), an answer is what the agent will read out loud (a few sentences),
 * and both go into a per-call prompt whose tokens are paid for on every single
 * call. A pasted three-page policy document would be quoted verbatim to a caller
 * and would blow up the prompt, so it is rejected at the edge and has to be split
 * into real question/answer pairs.
 */
import { z } from "@hono/zod-openapi";

import { unknownAnswerPolicy } from "@/db/schema";
import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";

/** Query paramlar satr bo'lib keladi, shuning uchun boolean flaglar "true"/"false". */
const boolQueryEnum = z.enum(["true", "false"]);

const unknownPolicyEnum = z.enum(unknownAnswerPolicy);

const questionSchema = z.string().trim().min(3).max(500);
const answerSchema = z.string().trim().min(1).max(4000);
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(10);
/** Bir necha yozuv mos kelganda yuqorisi yutadi (mavsumiy javobni tepaga qadash uchun). */
const prioritySchema = z.number().int().min(-1000).max(1000);

export const KnowledgeEntrySchema = z
	.object({
		id: uuidSchema,
		agentProfileId: uuidSchema,
		question: z.string(),
		answer: z.string(),
		tags: z.array(z.string()),
		priority: z.number().int(),
		isActive: z.boolean(),
		/** Agent bu javobni necha marta ishlatgani — qo'ng'iroq qiluvchilar nimani so'rashini ko'rsatadi. */
		useCount: z.number().int(),
		lastUsedAt: z.string().datetime().nullable(),
		createdBy: uuidSchema.nullable(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.openapi("KnowledgeBaseEntry");

export const ListQuerySchema = z
	.object({
		profileId: uuidSchema.optional().openapi({
			param: {
				name: "profileId",
				in: "query",
				description: "Berilmasa — aktiv profil olinadi",
			},
		}),
		q: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.optional()
			.openapi({
				param: {
					name: "q",
					in: "query",
					description: "Savol, javob va teglar bo'yicha oddiy matn izlash",
				},
			}),
		tag: z
			.string()
			.trim()
			.min(1)
			.max(40)
			.optional()
			.openapi({ param: { name: "tag", in: "query", description: "Aynan shu teg bor yozuvlar" } }),
		isActive: boolQueryEnum.optional().openapi({
			param: { name: "isActive", in: "query", description: "true — faqat yoqilgan yozuvlar" },
		}),
	})
	.merge(PaginationQuerySchema);

export const CreateBodySchema = z
	.object({
		/** Berilmasa aktiv profilga yoziladi (profil bo'lmasa — standart profil yaratiladi). */
		profileId: uuidSchema.optional(),
		question: questionSchema,
		answer: answerSchema,
		tags: tagsSchema.optional(),
		priority: prioritySchema.optional(),
		isActive: z.boolean().optional(),
	})
	.openapi("KnowledgeBaseCreateBody");

export const UpdateBodySchema = z
	.object({
		question: questionSchema.optional(),
		answer: answerSchema.optional(),
		tags: tagsSchema.nullable().optional(),
		priority: prioritySchema.optional(),
		isActive: z.boolean().optional(),
	})
	.refine((body) => Object.keys(body).length > 0, {
		message: "Kamida bitta maydon yuborilishi kerak",
	})
	.openapi("KnowledgeBaseUpdateBody");

/** Bir chaqiriqdagi yozuvlar soni cheklangan: import qatorlab yoziladi. */
const BULK_MAX_ENTRIES = 200;

export const BulkBodySchema = z
	.object({
		profileId: uuidSchema.optional(),
		entries: z
			.array(
				z.object({
					question: questionSchema,
					answer: answerSchema,
					tags: tagsSchema.optional(),
					priority: prioritySchema.optional(),
					isActive: z.boolean().optional(),
				})
			)
			.min(1)
			.max(BULK_MAX_ENTRIES),
	})
	.openapi("KnowledgeBaseBulkBody");

const bulkRowStatusEnum = z.enum(["created", "skipped", "failed"]);

export const BulkRowResultSchema = z
	.object({
		/** Yuborilgan massivdagi o'rin — xatoli qatorni topish uchun. */
		index: z.number().int(),
		status: bulkRowStatusEnum,
		question: z.string(),
		/** created bo'lsa — yangi yozuv id'si; skipped bo'lsa — mavjud yozuv id'si. */
		id: uuidSchema.nullable(),
		/** skipped/failed uchun sabab. */
		reason: z.string().nullable(),
	})
	.openapi("KnowledgeBaseBulkRowResult");

export const SearchBodySchema = z
	.object({
		query: z.string().trim().min(1).max(300),
		/** Berilmasa — aktiv profil, ya'ni haqiqiy qo'ng'iroqda ishlatiladigan profil. */
		profileId: uuidSchema.optional(),
		limit: z.number().int().min(1).max(20).optional(),
	})
	.openapi("KnowledgeBaseSearchBody");

export const SearchHitSchema = z
	.object({
		id: uuidSchema,
		question: z.string(),
		answer: z.string(),
		tags: z.array(z.string()),
		priority: z.number().int(),
		/** Moslik bali: savoldagi topilma javobdagidan qimmatroq. 0 bal — hit emas. */
		score: z.number().int(),
	})
	.openapi("KnowledgeBaseSearchHit");

export const TopEntrySchema = z
	.object({
		id: uuidSchema,
		question: z.string(),
		tags: z.array(z.string()),
		useCount: z.number().int(),
		lastUsedAt: z.string().datetime().nullable(),
		isActive: z.boolean(),
	})
	.openapi("KnowledgeBaseTopEntry");

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(KnowledgeEntrySchema),
		meta: PaginationMetaSchema,
		/** Qaysi profil bo'yicha filtrlangani (profileId berilmaganda aktiv profil). */
		profileId: uuidSchema.nullable(),
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: KnowledgeEntrySchema,
});

export const BulkOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		profileId: uuidSchema,
		created: z.number().int(),
		skipped: z.number().int(),
		failed: z.number().int(),
		/** Har bir qator uchun natija — import to'liq to'xtatilmaydi. */
		results: z.array(BulkRowResultSchema),
	}),
});

export const SearchOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		query: z.string(),
		profileId: uuidSchema.nullable(),
		businessName: z.string(),
		hitCount: z.number().int(),
		/** false bo'lsa — agent bu savolga javob bermaydi va unknownPolicy'ga o'tadi. */
		wouldAnswer: z.boolean(),
		unknownPolicy: unknownPolicyEnum,
		/** Javob topilmaganda agent nima qilishi, o'zbekcha tushuntirish. */
		fallbackAction: z.string(),
		hits: z.array(SearchHitSchema),
	}),
});

export const StatsQuerySchema = z.object({
	profileId: uuidSchema.optional().openapi({
		param: { name: "profileId", in: "query", description: "Berilmasa — aktiv profil" },
	}),
	limit: z
		.string()
		.optional()
		.default("10")
		.transform(Number)
		.pipe(z.number().int().min(1).max(50))
		.openapi({
			param: { name: "limit", in: "query", description: "Eng ko'p ishlatilgan yozuvlar soni" },
			example: "10",
		}),
});

export const StatsOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		profileId: uuidSchema.nullable(),
		businessName: z.string(),
		total: z.number().int(),
		active: z.number().int(),
		inactive: z.number().int(),
		/** Hech qachon ishlatilmagan yozuvlar — noto'g'ri yozilgan savollarning belgisi. */
		neverUsed: z.number().int(),
		/** Barcha yozuvlar bo'yicha umumiy ishlatilish soni. */
		totalUses: z.number().int(),
		lastUsedAt: z.string().datetime().nullable(),
		topEntries: z.array(TopEntrySchema),
	}),
});

export const DeleteOutSchema = z.object({
	success: z.literal(true),
	data: z.object({ message: z.string() }),
});

export type KnowledgeEntryItem = z.infer<typeof KnowledgeEntrySchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type CreateBody = z.infer<typeof CreateBodySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
export type BulkBody = z.infer<typeof BulkBodySchema>;
export type BulkRowResult = z.infer<typeof BulkRowResultSchema>;
export type StatsQuery = z.infer<typeof StatsQuerySchema>;
