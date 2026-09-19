import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, phoneSchema, uuidSchema } from "@/lib";

const callDirectionEnum = z.enum(["inbound", "outbound"]);
const callStatusEnum = z.enum(["ringing", "answered", "missed", "abandoned", "completed"]);
const aiStatusEnum = z.enum(["pending", "processing", "completed", "failed"]);
const sentimentEnum = z.enum(["positive", "neutral", "negative"]);
/** Query strings carry booleans as text; "true"/"false" keeps the OpenAPI honest. */
const booleanQueryEnum = z.enum(["true", "false"]);

export const CallItemSchema = z.object({
	id: uuidSchema,
	direction: callDirectionEnum,
	callerNumber: z.string(),
	calleeExtension: z.string().nullable(),
	contactId: uuidSchema.nullable(),
	contactName: z.string().nullable(),
	operatorId: uuidSchema.nullable(),
	ticketId: uuidSchema.nullable(),
	status: callStatusEnum,
	duration: z.number().int().nullable(),
	recordingPath: z.string().nullable(),
	aiStatus: aiStatusEnum.nullable(),
	startedAt: z.string().datetime(),
	endedAt: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
	/**
	 * The columns the merged call list scans by. Every one of them used to force
	 * the reader onto a different page - the recordings list to learn there was
	 * audio, the analysis list to learn the sentiment, the cost page to learn the
	 * price - so they are answered here, in the row itself.
	 */
	operatorName: z.string().nullable(),
	operatorExtension: z.string().nullable(),
	hasRecording: z.boolean(),
	hasTranscript: z.boolean(),
	sentiment: sentimentEnum.nullable(),
	/** null when the caller may not see money, or when nothing was priceable. */
	costUsd: z.number().nullable(),
});

export const CallOneSchema = z.object({
	id: uuidSchema,
	direction: callDirectionEnum,
	callerNumber: z.string(),
	calleeExtension: z.string().nullable(),
	contactId: uuidSchema.nullable(),
	contactName: z.string().nullable(),
	operatorId: uuidSchema.nullable(),
	ticketId: uuidSchema.nullable(),
	status: callStatusEnum,
	duration: z.number().int().nullable(),
	recordingPath: z.string().nullable(),
	aiStatus: aiStatusEnum.nullable(),
	startedAt: z.string().datetime(),
	endedAt: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
	contact: z
		.object({
			id: uuidSchema,
			phoneNumber: z.string(),
			firstName: z.string().nullable(),
			lastName: z.string().nullable(),
		})
		.nullable(),
	/**
	 * `phone` avval operator profilining `userId` sini qaytarardi, ya'ni UI da
	 * "Operator" yorlig'i ostida xom UUID ko'rinardi. Endi bu haqiqiy telefon
	 * raqami; `username` va `extension` esa qo'shimcha maydonlar (mavjud
	 * iste'molchilar uchun buzuvchi emas).
	 */
	operator: z
		.object({
			id: uuidSchema,
			phone: z.string(),
			username: z.string().nullable(),
			extension: z.string().nullable(),
		})
		.nullable(),
});

export const ListQuerySchema = z
	.object({
		phoneNumber: phoneSchema.optional().openapi({
			param: {
				name: "phoneNumber",
				in: "query",
				description: "Caller raqami bo'yicha filtrlash",
			},
		}),
		status: callStatusEnum.optional().openapi({ param: { name: "status", in: "query" } }),
		direction: callDirectionEnum.optional().openapi({ param: { name: "direction", in: "query" } }),
		operatorId: uuidSchema.optional().openapi({ param: { name: "operatorId", in: "query" } }),
		from: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "from", in: "query" } }),
		to: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "to", in: "query" } }),
		aiStatus: aiStatusEnum.optional().openapi({
			param: { name: "aiStatus", in: "query", description: "AI tahlili holati bo'yicha" },
		}),
		sentiment: sentimentEnum.optional().openapi({
			param: { name: "sentiment", in: "query", description: "AI aniqlagan kayfiyat bo'yicha" },
		}),
		hasRecording: booleanQueryEnum.optional().openapi({
			param: { name: "hasRecording", in: "query", description: "Ovoz yozuvi bor/yo'q" },
		}),
	})
	.merge(PaginationQuerySchema);

export const ExportQuerySchema = z.object({
	phoneNumber: phoneSchema.optional().openapi({
		param: { name: "phoneNumber", in: "query", description: "Caller raqami bo'yicha filtrlash" },
	}),
	status: callStatusEnum.optional().openapi({ param: { name: "status", in: "query" } }),
	direction: callDirectionEnum.optional().openapi({ param: { name: "direction", in: "query" } }),
	operatorId: uuidSchema.optional().openapi({ param: { name: "operatorId", in: "query" } }),
	from: z
		.string()
		.datetime()
		.optional()
		.openapi({ param: { name: "from", in: "query" } }),
	to: z
		.string()
		.datetime()
		.optional()
		.openapi({ param: { name: "to", in: "query" } }),
	aiStatus: aiStatusEnum.optional().openapi({ param: { name: "aiStatus", in: "query" } }),
	sentiment: sentimentEnum.optional().openapi({ param: { name: "sentiment", in: "query" } }),
	hasRecording: booleanQueryEnum
		.optional()
		.openapi({ param: { name: "hasRecording", in: "query" } }),
	format: z
		.enum(["csv", "xlsx"])
		.optional()
		.default("xlsx")
		.openapi({
			param: { name: "format", in: "query", description: "xlsx — Excel (default), csv — CSV" },
		}),
});

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(CallItemSchema),
		meta: PaginationMetaSchema,
		/**
		 * Whether `costUsd` is a figure or a redaction. Without it a manager could
		 * not tell "this call cost nothing" from "you may not see what it cost".
		 */
		costVisible: z.boolean(),
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: CallOneSchema,
});

export const MeStatsOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		totalCalls: z.number(),
		answeredCalls: z.number(),
		missedCalls: z.number(),
		avgTalkTime: z.number(),
		totalTalkTime: z.number(),
	}),
});

export type CallItem = z.infer<typeof CallItemSchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type ExportQuery = z.infer<typeof ExportQuerySchema>;
export type MeStatsOut = z.infer<typeof MeStatsOutSchema>;
