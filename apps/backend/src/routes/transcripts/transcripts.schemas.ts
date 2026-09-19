import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";

export const transcriptRoleEnum = z.enum(["caller", "agent", "system"]);

/** Query paramlar string bo'lib keladi, shuning uchun boolean flaglar "true"/"false". */
const boolQueryEnum = z.enum(["true", "false"]);

/**
 * Transkript qatorlari qo'ng'iroqqa tegishli, shuning uchun list/append path
 * paramı `callId`. Bitta qatorni tuzatish esa IdParamSchema (`/{id}`) bilan.
 */
export const CallIdParamSchema = z.object({
	callId: z
		.string()
		.uuid()
		.openapi({
			param: { name: "callId", in: "path", required: true },
			example: "123e4567-e89b-12d3-a456-426614174000",
		}),
});

export const TranscriptItemSchema = z
	.object({
		id: uuidSchema,
		callId: uuidSchema,
		aiSessionId: uuidSchema.nullable(),
		role: transcriptRoleEnum,
		content: z.string(),
		startMs: z.number().int().nullable(),
		endMs: z.number().int().nullable(),
		isFinal: z.boolean(),
		confidence: z.number().int().nullable(),
		createdAt: z.string().datetime(),
	})
	.openapi("TranscriptLineItem");

export const ListQuerySchema = z
	.object({
		role: transcriptRoleEnum.optional().openapi({
			param: { name: "role", in: "query", description: "caller / agent / system" },
		}),
		includeInterim: boolQueryEnum
			.optional()
			.default("false")
			.openapi({
				param: {
					name: "includeInterim",
					in: "query",
					description: "true — yakunlanmagan (isFinal=false) qatorlar ham qaytadi",
				},
			}),
		order: z
			.enum(["asc", "desc"])
			.optional()
			.default("asc")
			.openapi({
				param: { name: "order", in: "query", description: "Qo'ng'iroq vaqti bo'yicha tartib" },
			}),
		search: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.openapi({ param: { name: "search", in: "query", description: "Matn bo'yicha qidirish" } }),
	})
	.merge(PaginationQuerySchema);

export const ExportQuerySchema = z.object({
	format: z
		.enum(["txt", "csv"])
		.optional()
		.default("txt")
		.openapi({
			param: {
				name: "format",
				in: "query",
				description: "txt — oddiy matn (default), csv — CSV jadval",
			},
		}),
	role: transcriptRoleEnum.optional().openapi({
		param: { name: "role", in: "query", description: "caller / agent / system" },
	}),
	includeInterim: boolQueryEnum
		.optional()
		.default("false")
		.openapi({
			param: {
				name: "includeInterim",
				in: "query",
				description: "true — yakunlanmagan (isFinal=false) qatorlar ham eksport qilinadi",
			},
		}),
});

export const AppendBodySchema = z
	.object({
		role: transcriptRoleEnum,
		content: z.string().min(1).max(10_000),
		startMs: z.number().int().min(0).optional(),
		endMs: z.number().int().min(0).optional(),
		isFinal: z.boolean().optional().default(true),
		confidence: z.number().int().min(0).max(100).optional(),
		aiSessionId: z.string().uuid().optional(),
	})
	.openapi("TranscriptAppendBody");

export const UpdateBodySchema = z
	.object({
		content: z.string().min(1).max(10_000).optional(),
		role: transcriptRoleEnum.optional(),
		startMs: z.number().int().min(0).nullable().optional(),
		endMs: z.number().int().min(0).nullable().optional(),
		isFinal: z.boolean().optional(),
		confidence: z.number().int().min(0).max(100).nullable().optional(),
	})
	.openapi("TranscriptUpdateBody");

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(TranscriptItemSchema),
		meta: PaginationMetaSchema,
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: TranscriptItemSchema,
});

export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type ExportQuery = z.infer<typeof ExportQuerySchema>;
export type AppendBody = z.infer<typeof AppendBodySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
