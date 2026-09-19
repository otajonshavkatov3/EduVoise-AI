import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";

/**
 * Sana oralig'i majburiy va eng ko'pi bilan bir yil (TZ 3.7 — sana bo'yicha filter).
 * Cheklovsiz oraliq butun jadvalni skanerlashga olib keladi.
 */
export const MAX_RANGE_DAYS = 366;

/**
 * Bitta eksport faylida ruxsat etilgan maksimal qator soni. Bundan oshsa fayl
 * umuman generatsiya qilinmaydi — foydalanuvchiga oraliqni toraytirish taklif
 * qilinadi (million qatorni stream qilishdan ko'ra tushunarli xato yaxshi).
 *
 * Chegara o'lchov asosida tanlangan: exceljs butun kitobni xotirada quradi va
 * 16 ustunli jadvalda 10 000 qator ~0.6 s / ~360 MB RSS, 50 000 qator ~2.9 s /
 * ~1.1 GB RSS talab qildi. 20 000 qator — bir oylik intensiv qo'ng'iroq oqimini
 * qoplaydi va bitta so'rov serverni yotqizmaydi.
 */
export const MAX_EXPORT_ROWS = 20_000;

export const callStatusEnum = z.enum(["ringing", "answered", "missed", "abandoned", "completed"]);
export const callDirectionEnum = z.enum(["inbound", "outbound"]);
export const aiStatusEnum = z.enum(["pending", "processing", "completed", "failed"]);
export const ticketStatusEnum = z.enum(["new", "in_progress", "resolved", "closed", "reopened"]);
export const ticketPriorityEnum = z.enum(["low", "medium", "high"]);
export const sentimentEnum = z.enum(["positive", "neutral", "negative"]);
export const operatorStatusEnum = z.enum(["online", "offline", "pause", "busy"]);
export const exportFormatEnum = z.enum(["xlsx", "csv"]);

/** Barcha hisobotlar uchun umumiy majburiy sana oralig'i. */
const dateRangeShape = {
	from: z
		.string()
		.datetime()
		.openapi({
			param: {
				name: "from",
				in: "query",
				required: true,
				description: "Oraliq boshlanishi (ISO). Majburiy.",
			},
		}),
	to: z
		.string()
		.datetime()
		.openapi({
			param: {
				name: "to",
				in: "query",
				required: true,
				description: `Oraliq tugashi (ISO). Majburiy. from..to eng ko'pi bilan ${MAX_RANGE_DAYS} kun.`,
			},
		}),
};

const operatorIdQuery = uuidSchema.optional().openapi({
	param: {
		name: "operatorId",
		in: "query",
		description: "operatorProfiles.id (users.id emas)",
	},
});

const formatQuery = exportFormatEnum
	.optional()
	.default("xlsx")
	.openapi({
		param: {
			name: "format",
			in: "query",
			description: "xlsx — Excel (default), csv — CSV (UTF-8 BOM bilan)",
		},
	});

// --- Qo'ng'iroqlar hisoboti ---------------------------------------------------

const callFilterShape = {
	...dateRangeShape,
	operatorId: operatorIdQuery,
	status: callStatusEnum.optional().openapi({ param: { name: "status", in: "query" } }),
	direction: callDirectionEnum.optional().openapi({ param: { name: "direction", in: "query" } }),
};

export const CallsQuerySchema = z.object(callFilterShape).merge(PaginationQuerySchema);

export const CallsExportQuerySchema = z.object({ ...callFilterShape, format: formatQuery });

export const CallReportRowSchema = z
	.object({
		id: uuidSchema,
		startedAt: z.string().datetime(),
		answeredAt: z.string().datetime().nullable(),
		endedAt: z.string().datetime().nullable(),
		direction: callDirectionEnum,
		status: callStatusEnum,
		callerNumber: z.string(),
		calleeExtension: z.string().nullable(),
		durationSeconds: z.number().int().nullable(),
		/** answeredAt - startedAt. answeredAt yangi ustun — eski qatorlarda null. */
		waitSeconds: z.number().int().nullable(),
		contactName: z.string().nullable(),
		contactPhone: z.string().nullable(),
		operatorExtension: z.string().nullable(),
		operatorPhone: z.string().nullable(),
		ticketId: uuidSchema.nullable(),
		ticketSubject: z.string().nullable(),
		aiStatus: aiStatusEnum.nullable(),
	})
	.openapi("CallReportRow");

export const CallsSummarySchema = z
	.object({
		totalCalls: z.number().int(),
		inboundCalls: z.number().int(),
		outboundCalls: z.number().int(),
		answeredCalls: z.number().int(),
		missedCalls: z.number().int(),
		abandonedCalls: z.number().int(),
		/** Foiz (bir kasr belgi). Qo'ng'iroq bo'lmasa null — 0 emas. */
		answeredRate: z.number().nullable(),
		/** Faqat javob berilgan qo'ng'iroqlar bo'yicha. Namuna bo'lmasa null. */
		avgTalkSeconds: z.number().int().nullable(),
		totalTalkSeconds: z.number().int(),
		talkSampleCount: z.number().int(),
		/** answeredAt to'ldirilgan qatorlar bo'yicha. Namuna bo'lmasa null. */
		avgWaitSeconds: z.number().int().nullable(),
		totalWaitSeconds: z.number().int(),
		waitSampleCount: z.number().int(),
	})
	.openapi("CallsReportSummary");

// --- Murojaatlar (ticketlar) hisoboti ----------------------------------------

const ticketFilterShape = {
	...dateRangeShape,
	operatorId: operatorIdQuery,
	status: ticketStatusEnum.optional().openapi({ param: { name: "status", in: "query" } }),
	priority: ticketPriorityEnum.optional().openapi({ param: { name: "priority", in: "query" } }),
	category: z
		.string()
		.min(1)
		.max(100)
		.optional()
		.openapi({
			param: {
				name: "category",
				in: "query",
				description: "Kategoriya bo'yicha qidirish (qismiy moslik)",
			},
		}),
};

export const TicketsQuerySchema = z.object(ticketFilterShape).merge(PaginationQuerySchema);

export const TicketsExportQuerySchema = z.object({ ...ticketFilterShape, format: formatQuery });

export const TicketReportRowSchema = z
	.object({
		id: uuidSchema,
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		closedAt: z.string().datetime().nullable(),
		subject: z.string(),
		category: z.string().nullable(),
		priority: ticketPriorityEnum,
		status: ticketStatusEnum,
		contactName: z.string().nullable(),
		contactPhone: z.string().nullable(),
		createdByPhone: z.string().nullable(),
		createdByUsername: z.string().nullable(),
		externalRefId: z.string().nullable(),
		aiSentiment: sentimentEnum.nullable(),
		aiConfidence: z.number().int().nullable(),
		/** closedAt - createdAt (soat). Yopilmagan ticketda null. */
		resolutionHours: z.number().nullable(),
	})
	.openapi("TicketReportRow");

export const TicketsSummarySchema = z
	.object({
		totalTickets: z.number().int(),
		statusNew: z.number().int(),
		statusInProgress: z.number().int(),
		statusResolved: z.number().int(),
		statusClosed: z.number().int(),
		statusReopened: z.number().int(),
		priorityLow: z.number().int(),
		priorityMedium: z.number().int(),
		priorityHigh: z.number().int(),
		sentimentPositive: z.number().int(),
		sentimentNeutral: z.number().int(),
		sentimentNegative: z.number().int(),
		/** AI tahlil qilmagan (aiSentiment null) ticketlar. */
		sentimentUnknown: z.number().int(),
		/** Yopilgan ticketlar ulushi, foiz. Ticket bo'lmasa null. */
		closedRate: z.number().nullable(),
		/** closedAt to'ldirilgan ticketlar bo'yicha o'rtacha. Namuna bo'lmasa null. */
		avgResolutionHours: z.number().nullable(),
		resolutionSampleCount: z.number().int(),
	})
	.openapi("TicketsReportSummary");

// --- Operatorlar hisoboti ----------------------------------------------------

const operatorFilterShape = {
	...dateRangeShape,
	operatorId: operatorIdQuery,
	direction: callDirectionEnum.optional().openapi({
		param: {
			name: "direction",
			in: "query",
			description: "Faqat shu yo'nalishdagi qo'ng'iroqlar hisobga olinadi",
		},
	}),
};

export const OperatorsQuerySchema = z.object(operatorFilterShape).merge(PaginationQuerySchema);

export const OperatorsExportQuerySchema = z.object({
	...operatorFilterShape,
	format: formatQuery,
});

export const OperatorReportRowSchema = z
	.object({
		operatorId: uuidSchema,
		userId: uuidSchema,
		extension: z.string(),
		userPhone: z.string(),
		username: z.string().nullable(),
		currentStatus: operatorStatusEnum,
		/** Profil o'chirilgan, lekin oraliqda faoliyati bo'lgan operatorlar ham ko'rsatiladi. */
		isDeleted: z.boolean(),
		totalCalls: z.number().int(),
		inboundCalls: z.number().int(),
		outboundCalls: z.number().int(),
		answeredCalls: z.number().int(),
		missedCalls: z.number().int(),
		abandonedCalls: z.number().int(),
		answeredRate: z.number().nullable(),
		avgTalkSeconds: z.number().int().nullable(),
		totalTalkSeconds: z.number().int(),
		talkSampleCount: z.number().int(),
		avgWaitSeconds: z.number().int().nullable(),
		waitSampleCount: z.number().int(),
		ticketsCreated: z.number().int(),
	})
	.openapi("OperatorReportRow");

export const OperatorsSummarySchema = z
	.object({
		operatorCount: z.number().int(),
		totalCalls: z.number().int(),
		inboundCalls: z.number().int(),
		outboundCalls: z.number().int(),
		answeredCalls: z.number().int(),
		missedCalls: z.number().int(),
		abandonedCalls: z.number().int(),
		answeredRate: z.number().nullable(),
		avgTalkSeconds: z.number().int().nullable(),
		totalTalkSeconds: z.number().int(),
		talkSampleCount: z.number().int(),
		avgWaitSeconds: z.number().int().nullable(),
		waitSampleCount: z.number().int(),
		ticketsCreated: z.number().int(),
		/**
		 * Operatorga bog'lanmagan qo'ng'iroqlar (operatorId NULL) — bu hisobot
		 * qatorlariga kirmaydi, lekin qo'ng'iroqlar hisoboti bilan solishtirganda
		 * farq qayerdan kelganini ko'rsatadi.
		 */
		unassignedCalls: z.number().int(),
	})
	.openapi("OperatorsReportSummary");

// --- Umumiy javob qobiqlari --------------------------------------------------

export const ReportRangeSchema = z
	.object({
		from: z.string().datetime(),
		to: z.string().datetime(),
		days: z.number().int(),
		/** Sana/vaqt qiymatlari hisobotda shu zonada ko'rsatiladi. */
		timeZone: z.string(),
	})
	.openapi("ReportRange");

export const CallsReportOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(CallReportRowSchema),
		meta: PaginationMetaSchema,
		summary: CallsSummarySchema,
		range: ReportRangeSchema,
	}),
});

export const TicketsReportOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(TicketReportRowSchema),
		meta: PaginationMetaSchema,
		summary: TicketsSummarySchema,
		range: ReportRangeSchema,
	}),
});

export const OperatorsReportOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(OperatorReportRowSchema),
		meta: PaginationMetaSchema,
		summary: OperatorsSummarySchema,
		range: ReportRangeSchema,
	}),
});

export type CallsQuery = z.infer<typeof CallsQuerySchema>;
export type CallsExportQuery = z.infer<typeof CallsExportQuerySchema>;
export type CallReportRow = z.infer<typeof CallReportRowSchema>;
export type CallsSummary = z.infer<typeof CallsSummarySchema>;
export type TicketsQuery = z.infer<typeof TicketsQuerySchema>;
export type TicketsExportQuery = z.infer<typeof TicketsExportQuerySchema>;
export type TicketReportRow = z.infer<typeof TicketReportRowSchema>;
export type TicketsSummary = z.infer<typeof TicketsSummarySchema>;
export type OperatorsQuery = z.infer<typeof OperatorsQuerySchema>;
export type OperatorsExportQuery = z.infer<typeof OperatorsExportQuerySchema>;
export type OperatorReportRow = z.infer<typeof OperatorReportRowSchema>;
export type OperatorsSummary = z.infer<typeof OperatorsSummarySchema>;
export type ReportRange = z.infer<typeof ReportRangeSchema>;
export type ExportFormat = z.infer<typeof exportFormatEnum>;
