import { z } from "@hono/zod-openapi";

import { uuidSchema } from "@/lib";

/**
 * MAVJUD javob shakli — o'zgartirilmaydi. Boshqa kod shu maydonlarni o'qiydi.
 * Yangi ko'rsatkichlar quyidagi /overview, /call-volume, /missed-calls
 * endpointlariga qo'shildi.
 */
export const DashboardSummarySchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			totalCalls: z.number().int(),
			inboundCalls: z.number().int(),
			outboundCalls: z.number().int(),
			answeredCalls: z.number().int(),
			missedCalls: z.number().int(),
			avgDurationSec: z.number().int(),
		}),
	})
	.openapi("DashboardSummaryResponse");

export type DashboardSummaryResponse = z.infer<typeof DashboardSummarySchema>;

export const dashboardPeriodEnum = z.enum(["day", "week", "month"]);

export const PeriodQuerySchema = z.object({
	period: dashboardPeriodEnum
		.optional()
		.default("day")
		.openapi({
			param: {
				name: "period",
				in: "query",
				description: "day — bugun (soatlik), week — oxirgi 7 kun, month — oxirgi 30 kun",
			},
		}),
});

export const MissedCallsQuerySchema = PeriodQuerySchema.extend({
	limit: z
		.string()
		.optional()
		.default("10")
		.transform(Number)
		.pipe(z.number().int().min(1).max(50))
		.openapi({ param: { name: "limit", in: "query" }, example: "10" }),
});

const RangeSchema = z
	.object({
		from: z.string().datetime(),
		to: z.string().datetime(),
	})
	.openapi("DashboardRange");

const ScopeSchema = z
	.object({
		/** true — manager rejimi: faqat shu operatorning raqamlari. */
		operatorScoped: z.boolean(),
		/** false bo'lsa managerga operator profili biriktirilmagan — hamma son 0 bo'ladi. */
		hasOperatorProfile: z.boolean(),
	})
	.openapi("DashboardScope");

const CallStatsSchema = z
	.object({
		total: z.number().int(),
		inbound: z.number().int(),
		outbound: z.number().int(),
		/** status IN ('answered','completed'). */
		answered: z.number().int(),
		missed: z.number().int(),
		abandoned: z.number().int(),
		ringing: z.number().int(),
		/** missed + abandoned. */
		unanswered: z.number().int(),
		/** Foiz (1 kasr xona). Yakunlangan qo'ng'iroq bo'lmasa null. */
		answerRate: z.number().nullable(),
		/** Sekund. Namuna bo'lmasa null — UI "ma'lumot yo'q" ko'rsatadi. */
		avgTalkTimeSec: z.number().int().nullable(),
		totalTalkTimeSec: z.number().int(),
		talkTimeSampleSize: z.number().int(),
		/** answeredAt - startedAt o'rtachasi (sekund). answeredAt NULL qatorlar hisobga olinmaydi. */
		avgWaitingTimeSec: z.number().int().nullable(),
		waitingTimeSampleSize: z.number().int(),
	})
	.openapi("DashboardCallStats");

const OperatorStatusSchema = z
	.object({
		total: z.number().int(),
		/** online + busy. */
		active: z.number().int(),
		online: z.number().int(),
		busy: z.number().int(),
		pause: z.number().int(),
		offline: z.number().int(),
	})
	.openapi("DashboardOperatorStatus");

const OperatorWorkloadSchema = z
	.object({
		operatorId: uuidSchema,
		extension: z.string(),
		name: z.string(),
		currentStatus: z.enum(["online", "offline", "pause", "busy"]),
		totalCalls: z.number().int(),
		answeredCalls: z.number().int(),
		missedCalls: z.number().int(),
		avgTalkTimeSec: z.number().int().nullable(),
		totalTalkTimeSec: z.number().int(),
	})
	.openapi("DashboardOperatorWorkload");

const SentimentSchema = z
	.object({
		positive: z.number().int(),
		neutral: z.number().int(),
		negative: z.number().int(),
		/** Kayfiyat yozilgan tahlillar soni — foizlarning maxraji. */
		analyzed: z.number().int(),
	})
	.openapi("DashboardSentiment");

const CategoryCountSchema = z
	.object({
		/** null — ticketda kategoriya ko'rsatilmagan. */
		category: z.string().nullable(),
		count: z.number().int(),
	})
	.openapi("DashboardCategoryCount");

export const DashboardOverviewSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			period: dashboardPeriodEnum,
			range: RangeSchema,
			/** Teng uzunlikdagi oldingi oraliq — o'zgarish foizini UI o'zi hisoblaydi. */
			previousRange: RangeSchema,
			scope: ScopeSchema,
			current: CallStatsSchema,
			previous: CallStatsSchema,
			operators: OperatorStatusSchema,
			operatorWorkload: z.array(OperatorWorkloadSchema),
			sentiment: SentimentSchema,
			/** tickets.category bo'yicha. */
			ticketCategories: z.array(CategoryCountSchema),
			/** aiAnalyses.categories (jsonb massiv) bo'yicha. */
			aiCategories: z.array(CategoryCountSchema),
		}),
	})
	.openapi("DashboardOverviewResponse");

const VolumeBucketSchema = z
	.object({
		bucketStart: z.string().datetime(),
		/** "14:00" (soatlik) yoki "27.03" (kunlik). */
		label: z.string(),
		total: z.number().int(),
		inbound: z.number().int(),
		outbound: z.number().int(),
		answered: z.number().int(),
		missed: z.number().int(),
		abandoned: z.number().int(),
		unanswered: z.number().int(),
	})
	.openapi("DashboardVolumeBucket");

export const DashboardCallVolumeSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			period: dashboardPeriodEnum,
			granularity: z.enum(["hour", "day"]),
			range: RangeSchema,
			scope: ScopeSchema,
			buckets: z.array(VolumeBucketSchema),
			/** Ustunlar yig'indisi — bo'sh holatni aniqlash uchun. */
			totalCalls: z.number().int(),
		}),
	})
	.openapi("DashboardCallVolumeResponse");

const MissedCallSchema = z
	.object({
		id: uuidSchema,
		callerNumber: z.string(),
		contactId: uuidSchema.nullable(),
		/** Kontakt topilmasa null — UI raqamni ko'rsatadi. */
		contactName: z.string().nullable(),
		direction: z.enum(["inbound", "outbound"]),
		/** Haqiqiy status: 'missed' yoki 'abandoned'. */
		status: z.enum(["missed", "abandoned"]),
		calleeExtension: z.string().nullable(),
		operatorExtension: z.string().nullable(),
		startedAt: z.string().datetime(),
		endedAt: z.string().datetime().nullable(),
		/** Qo'ng'iroq yo'qolgunga qadar necha sekund jiringladi. */
		ringSec: z.number().int().nullable(),
	})
	.openapi("DashboardMissedCall");

export const DashboardMissedCallsSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			period: dashboardPeriodEnum,
			range: RangeSchema,
			scope: ScopeSchema,
			items: z.array(MissedCallSchema),
			/** Oraliqdagi barcha javobsiz qo'ng'iroqlar soni (limitdan qat'i nazar). */
			total: z.number().int(),
		}),
	})
	.openapi("DashboardMissedCallsResponse");

export type PeriodQuery = z.infer<typeof PeriodQuerySchema>;
export type MissedCallsQuery = z.infer<typeof MissedCallsQuerySchema>;
export type DashboardOverviewResponse = z.infer<typeof DashboardOverviewSchema>;
export type DashboardCallVolumeResponse = z.infer<typeof DashboardCallVolumeSchema>;
export type DashboardMissedCallsResponse = z.infer<typeof DashboardMissedCallsSchema>;
