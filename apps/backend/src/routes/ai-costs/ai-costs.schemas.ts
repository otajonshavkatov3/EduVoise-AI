import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";

/** Reports use the same ceiling; an unbounded range scans the whole table. */
export const MAX_RANGE_DAYS = 366;

export const groupByEnum = z.enum(["day", "week", "month"]);
export const costSortEnum = z.enum(["cost", "duration", "startedAt"]);

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
				description: `Oraliq tugashi (ISO). Majburiy. Oraliq eng ko'pi bilan ${MAX_RANGE_DAYS} kun.`,
			},
		}),
};

/**
 * The same range as the other two endpoints, but optional here.
 *
 * observedModels is a statement about the loaded data, so it has to answer for the
 * range the page is scoped to - otherwise the footnote describes all history under
 * a header naming one month. Optional rather than required so a caller that only
 * wants the rate table itself is unaffected.
 */
export const RatesQuerySchema = z.object({
	from: z
		.string()
		.datetime()
		.optional()
		.openapi({
			param: { name: "from", in: "query", description: "Oraliq boshlanishi (ISO). Ixtiyoriy." },
		}),
	to: z
		.string()
		.datetime()
		.optional()
		.openapi({
			param: { name: "to", in: "query", description: "Oraliq tugashi (ISO). Ixtiyoriy." },
		}),
});

const providerQuery = z
	.string()
	.max(50)
	.optional()
	.openapi({
		param: {
			name: "provider",
			in: "query",
			description: "ai_sessions.provider qiymati, masalan gemini-live",
		},
	});

export const SummaryQuerySchema = z.object({
	...dateRangeShape,
	groupBy: groupByEnum
		.optional()
		.default("day")
		.openapi({ param: { name: "groupBy", in: "query" } }),
});

export const CallsQuerySchema = z
	.object({
		...dateRangeShape,
		provider: providerQuery,
		sort: costSortEnum
			.optional()
			.default("cost")
			.openapi({
				param: {
					name: "sort",
					in: "query",
					description:
						"cost — eng qimmatdan boshlab (narxlanmagan sessiyalar oxirida), duration — eng uzundan, startedAt — eng yangidan",
				},
			}),
	})
	.merge(PaginationQuerySchema);

// ===========================================
// Shared money shapes
// ===========================================

/**
 * Every money field is nullable and every nullable one means the same thing:
 * the figure is not known. The UI renders null as "ma'lumot yo'q" and never as 0.
 */
const usd = z.number().nullable();

export const TokenBucketsSchema = z
	.object({
		/** Umumiy hisob — har bir sessiyada bor, eski qatorlarda ham. */
		promptTokens: z.number().int(),
		completionTokens: z.number().int(),
		/**
		 * Quyidagi taqsimot nechta sessiyadan yig'ilgani. Eski qatorlar taqsimot
		 * bermaydi, shuning uchun bu son umumiy sessiya sonidan kam bo'lishi mumkin.
		 */
		breakdownSessions: z.number().int(),
		cachedPromptTokens: z.number().int(),
		freshPromptTokens: z.number().int(),
		inputTextTokens: z.number().int(),
		inputAudioTokens: z.number().int(),
		outputTextTokens: z.number().int(),
		outputAudioTokens: z.number().int(),
		responseTurns: z.number().int(),
		/** Keshdan olingan prompt ulushi, 0..100. Taqsimot bo'lmasa null. */
		cachedSharePct: z.number().nullable(),
		costUsd: usd,
		/** Kirish narxi taqsimlangan — aniq o'lchov emas. */
		estimated: z.boolean(),
	})
	.openapi("AiCostTokenBuckets");

export const TranscriptionBucketSchema = z
	.object({
		audioTokens: z.number().int(),
		textTokens: z.number().int(),
		costUsd: usd,
		/** Sessiya ichida bajarilgani uchun alohida to'lov yo'q (Gemini). */
		notApplicableSessions: z.number().int(),
	})
	.openapi("AiCostTranscriptionBucket");

export const AnalysisBucketSchema = z
	.object({
		billedRuns: z.number().int(),
		promptTokens: z.number().int(),
		cachedPromptTokens: z.number().int(),
		completionTokens: z.number().int(),
		costUsd: usd,
		/** Tahlil bor, lekin token hisobi yo'q (ustunlar paydo bo'lishidan oldingi). */
		unmeasuredAnalyses: z.number().int(),
		/** Xatolik bilan tugagan tahlillar: hech narsa ishlab chiqarmagan, narxi ham yo'q. */
		failedAnalyses: z.number().int(),
	})
	.openapi("AiCostAnalysisBucket");

// ===========================================
// GET /summary
// ===========================================

export const CostRangeSchema = z
	.object({
		from: z.string().datetime(),
		to: z.string().datetime(),
		days: z.number().int(),
		groupBy: groupByEnum,
		/**
		 * `series[].bucket` kalitlari shu mintaqa bo'yicha kesilgan (general.timezone).
		 * Ustunlar qaysi kunni bildirishini bilish uchun kerak — UTC emas.
		 */
		timeZone: z.string(),
	})
	.openapi("AiCostRange");

export const CostTotalsSchema = z
	.object({
		sessions: z.number().int(),
		/** Narxi hisoblangan sessiyalar. */
		pricedSessions: z.number().int(),
		/** Ma'lumoti yetmagani uchun narxlanmagan sessiyalar. */
		unpricedSessions: z.number().int(),
		/** Ustunlar qo'shilishidan oldingi eski sessiyalar — taqsimoti yo'q. */
		legacySessions: z.number().int(),
		callSeconds: z.number().int(),
		/** Faqat narxlangan sessiyalar davomiyligi — daqiqa narxining maxraji. */
		pricedCallSeconds: z.number().int(),
		voice: TokenBucketsSchema,
		transcription: TranscriptionBucketSchema,
		analysis: AnalysisBucketSchema,
		costUsd: usd,
		costUzs: z.number().nullable(),
		/** Narxlangan sessiyalar bo'yicha. Namuna bo'lmasa null. */
		costPerCallUsd: usd,
		costPerMinuteUsd: usd,
	})
	.openapi("AiCostTotals");

export const ProviderSplitRowSchema = z
	.object({
		provider: z.string(),
		model: z.string().nullable(),
		sessions: z.number().int(),
		pricedSessions: z.number().int(),
		callSeconds: z.number().int(),
		voice: TokenBucketsSchema,
		transcription: TranscriptionBucketSchema,
		analysis: AnalysisBucketSchema,
		costUsd: usd,
		costPerMinuteUsd: usd,
	})
	.openapi("AiCostProviderSplitRow");

export const CostSeriesPointSchema = z
	.object({
		bucket: z.string(),
		sessions: z.number().int(),
		voiceCostUsd: usd,
		transcriptionCostUsd: usd,
		analysisCostUsd: usd,
		costUsd: usd,
	})
	.openapi("AiCostSeriesPoint");

export const RateItemSchema = z
	.object({
		key: z.string(),
		label: z.string(),
		value: z.number(),
		/** Hech kim tahrirlamagan — oldindan kiritilgan standart qiymat. */
		isDefault: z.boolean(),
	})
	.openapi("AiCostRateItem");

export const PricingStatusSchema = z
	.object({
		/** Kamida bitta narx kiritilgan va nolga teng emas. */
		configured: z.boolean(),
		/** Hech kim tasdiqlamagan standart narxlar soni. */
		unreviewedCount: z.number().int(),
		/** Nolga tenglashtirilgani uchun hisoblanmaydigan qatorlar. */
		zeroKeys: z.array(z.string()),
		lastReviewedAt: z.string().datetime().nullable(),
		usdToUzs: z.number(),
	})
	.openapi("AiCostPricingStatus");

export const SummaryOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		range: CostRangeSchema,
		pricing: PricingStatusSchema,
		totals: CostTotalsSchema,
		byProvider: z.array(ProviderSplitRowSchema),
		series: z.array(CostSeriesPointSchema),
		/** Har bir raqamning cheklovi — o'zbekcha, sahifada tagida ko'rsatiladi. */
		estimateNotes: z.array(z.string()),
	}),
});

// ===========================================
// GET /calls
// ===========================================

export const CostCallRowSchema = z
	.object({
		sessionId: uuidSchema,
		callId: uuidSchema,
		startedAt: z.string().datetime(),
		callerNumber: z.string(),
		durationMs: z.number().int().nullable(),
		provider: z.string(),
		model: z.string().nullable(),
		responseTurns: z.number().int().nullable(),
		promptTokens: z.number().int().nullable(),
		cachedPromptTokens: z.number().int().nullable(),
		cachedSharePct: z.number().nullable(),
		completionTokens: z.number().int().nullable(),
		outputAudioTokens: z.number().int().nullable(),
		voiceCostUsd: usd,
		transcriptionCostUsd: usd,
		analysisCostUsd: usd,
		totalCostUsd: usd,
		costPerMinuteUsd: usd,
		estimated: z.boolean(),
		/** Narxlanmagan bo'lsa sababi: no-usage | no-breakdown | provider-not-priced | rates-not-set */
		unpricedReason: z.string().nullable(),
	})
	.openapi("AiCostCallRow");

export const CallsOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(CostCallRowSchema),
		meta: PaginationMetaSchema,
	}),
});

// ===========================================
// GET /rates
// ===========================================

export const RatesOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		pricing: PricingStatusSchema,
		items: z.array(RateItemSchema),
		/** Oraliqdagi ma'lumotda uchragan provider/model juftliklari. */
		observedModels: z.array(z.object({ provider: z.string(), model: z.string().nullable() })),
	}),
});

export type SummaryQuery = z.infer<typeof SummaryQuerySchema>;
export type CostCallsQuery = z.infer<typeof CallsQuerySchema>;
export type TokenBuckets = z.infer<typeof TokenBucketsSchema>;
export type TranscriptionBucket = z.infer<typeof TranscriptionBucketSchema>;
export type AnalysisBucket = z.infer<typeof AnalysisBucketSchema>;
export type ProviderSplitRow = z.infer<typeof ProviderSplitRowSchema>;
export type CostSeriesPoint = z.infer<typeof CostSeriesPointSchema>;
export type CostCallRow = z.infer<typeof CostCallRowSchema>;
export type PricingStatus = z.infer<typeof PricingStatusSchema>;
export type GroupBy = z.infer<typeof groupByEnum>;
