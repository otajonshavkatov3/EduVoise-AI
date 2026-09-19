import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";

export const aiAnalysisStatusEnum = z.enum(["pending", "processing", "completed", "failed"]);
export const sentimentEnum = z.enum(["positive", "neutral", "negative"]);
export const transcriptRoleEnum = z.enum(["caller", "agent", "system"]);

const callDirectionEnum = z.enum(["inbound", "outbound"]);
const callStatusEnum = z.enum(["ringing", "answered", "missed", "abandoned", "completed"]);
const ticketStatusEnum = z.enum(["new", "in_progress", "resolved", "closed", "reopened"]);
const ticketPriorityEnum = z.enum(["low", "medium", "high"]);

/** Query paramlar string bo'lib keladi, shuning uchun boolean flaglar "true"/"false". */
const boolQueryEnum = z.enum(["true", "false"]);

/** Tahlil qaysi qo'ng'iroqqa tegishli — ro'yxat o'qiladigan bo'lishi uchun. */
export const AnalysisCallSchema = z
	.object({
		id: uuidSchema,
		direction: callDirectionEnum,
		callerNumber: z.string(),
		calleeExtension: z.string().nullable(),
		status: callStatusEnum,
		duration: z.number().int().nullable(),
		aiStatus: aiAnalysisStatusEnum.nullable(),
		recordingPath: z.string().nullable(),
		startedAt: z.string().datetime(),
		endedAt: z.string().datetime().nullable(),
		ticketId: uuidSchema.nullable(),
		operatorId: uuidSchema.nullable(),
		/** operatorProfiles.extension — qo'ng'iroqni qaysi operator olganini ko'rsatadi. */
		operatorExtension: z.string().nullable(),
	})
	.openapi("AiAnalysisCall");

export const AnalysisContactSchema = z
	.object({
		id: uuidSchema,
		phoneNumber: z.string(),
		firstName: z.string().nullable(),
		lastName: z.string().nullable(),
	})
	.openapi("AiAnalysisContact");

export const AnalysisTicketSchema = z
	.object({
		id: uuidSchema,
		subject: z.string(),
		status: ticketStatusEnum,
		priority: ticketPriorityEnum,
	})
	.openapi("AiAnalysisTicket");

export const AnalysisTranscriptLineSchema = z
	.object({
		id: uuidSchema,
		role: transcriptRoleEnum,
		content: z.string(),
		startMs: z.number().int().nullable(),
		endMs: z.number().int().nullable(),
		confidence: z.number().int().nullable(),
		createdAt: z.string().datetime(),
	})
	.openapi("AiAnalysisTranscriptLine");

/**
 * Qo'lda tuzatish tarixi auditLogs'dan o'qiladi — jadvalga yangi ustun
 * qo'shilmagan. Tuzatish bo'lmagan bo'lsa null qaytadi (bo'sh qiymat o'ylab
 * topilmaydi).
 */
export const AnalysisCorrectionSchema = z
	.object({
		at: z.string().datetime(),
		byUserId: uuidSchema.nullable(),
		byPhone: z.string().nullable(),
	})
	.openapi("AiAnalysisCorrection");

const itemFields = {
	id: uuidSchema,
	callId: uuidSchema,
	status: aiAnalysisStatusEnum,
	sentiment: sentimentEnum.nullable(),
	categories: z.array(z.string()).nullable(),
	confidence: z.number().int().nullable(),
	summary: z.string().nullable(),
	/** Bo'sh bo'lmagan xulosa bor-yo'qligi (filtr bilan bir xil mantiq). */
	hasSummary: z.boolean(),
	/** Transkript saqlangani — retry shu asosda mumkin yoki mumkin emas. */
	hasTranscript: z.boolean(),
	transcriptChars: z.number().int(),
	errorMessage: z.string().nullable(),
	retryCount: z.number().int(),
	processedAt: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
	call: AnalysisCallSchema.nullable(),
	contact: AnalysisContactSchema.nullable(),
};

export const AiAnalysisItemSchema = z.object(itemFields).openapi("AiAnalysisItem");

export const AiAnalysisDetailSchema = z
	.object({
		...itemFields,
		/** Tahlil paytida saqlangan to'liq matn (bitta blok). */
		transcript: z.string().nullable(),
		/** callTranscripts jadvalidagi yakuniy qatorlar, vaqt bo'yicha. */
		transcriptLines: z.array(AnalysisTranscriptLineSchema),
		transcriptLineCount: z.number().int(),
		callerTurnCount: z.number().int(),
		ticket: AnalysisTicketSchema.nullable(),
		lastCorrection: AnalysisCorrectionSchema.nullable(),
	})
	.openapi("AiAnalysisDetail");

export const ListQuerySchema = z
	.object({
		status: aiAnalysisStatusEnum.optional().openapi({
			param: {
				name: "status",
				in: "query",
				description: "pending | processing | completed | failed",
			},
		}),
		sentiment: sentimentEnum.optional().openapi({
			param: { name: "sentiment", in: "query", description: "positive | neutral | negative" },
		}),
		callId: uuidSchema.optional().openapi({ param: { name: "callId", in: "query" } }),
		hasSummary: boolQueryEnum.optional().openapi({
			param: {
				name: "hasSummary",
				in: "query",
				description: "true — xulosa yozilgan, false — xulosa yo'q",
			},
		}),
		from: z
			.string()
			.datetime()
			.optional()
			.openapi({
				param: { name: "from", in: "query", description: "Tahlil yaratilgan vaqti >= (ISO)" },
			}),
		to: z
			.string()
			.datetime()
			.optional()
			.openapi({
				param: { name: "to", in: "query", description: "Tahlil yaratilgan vaqti <= (ISO)" },
			}),
	})
	.merge(PaginationQuerySchema);

export const UpdateBodySchema = z
	.object({
		/** null — noto'g'ri xulosani tozalash. Bo'sh satr qabul qilinmaydi. */
		summary: z.string().trim().min(1).max(4000).nullable().optional(),
		sentiment: sentimentEnum.nullable().optional(),
		categories: z.array(z.string().trim().min(1).max(100)).max(8).nullable().optional(),
	})
	.openapi("AiAnalysisUpdateBody");

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(AiAnalysisItemSchema),
		meta: PaginationMetaSchema,
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: AiAnalysisDetailSchema,
});

export type AiAnalysisItem = z.infer<typeof AiAnalysisItemSchema>;
export type AiAnalysisDetail = z.infer<typeof AiAnalysisDetailSchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
