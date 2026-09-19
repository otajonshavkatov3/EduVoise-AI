import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { commonResponses } from "@/lib";

import {
	CallsOutSchema,
	CallsQuerySchema,
	MAX_RANGE_DAYS,
	RatesOutSchema,
	RatesQuerySchema,
	SummaryOutSchema,
	SummaryQuerySchema,
} from "./ai-costs.schemas";

/**
 * Money is business finance, so this group is gated like Reports rather than
 * like the AI assistant pages - a manager who may review their own sessions has
 * no business reading the company's spend.
 */
const RBAC_NOTE = "Faqat supervisor va admin.";
const RANGE_NOTE = `from va to majburiy, oraliq eng ko'pi bilan ${MAX_RANGE_DAYS} kun.`;
const PRICING_NOTE =
	"Narx o'qish paytida joriy narxlar bo'yicha hisoblanadi va bazada saqlanmaydi — narxni tuzatish butun tarixni qayta narxlaydi. " +
	"Hisoblab bo'lmagan qiymat null qaytadi (0 emas).";

export const summary = createRoute({
	method: "get",
	path: "/summary",
	tags: ["AI Costs"],
	summary: "AI spend for a period: totals, per-provider split and a time series",
	description: `Oraliq bo'yicha jamlanma: umumiy xarajat, token taqsimoti, provayder/model kesimi va vaqt qatori. ${RANGE_NOTE} ${PRICING_NOTE} ${RBAC_NOTE}`,
	request: { query: SummaryQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: SummaryOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const costCalls = createRoute({
	method: "get",
	path: "/calls",
	tags: ["AI Costs"],
	summary: "Per-call cost with the token breakdown behind it",
	description: `Har bir sessiya: narxi va uni tushuntiruvchi ustunlar (davomiyligi, javoblar soni, kesh ulushi, chiquvchi audio tokenlar). ${RANGE_NOTE} ${PRICING_NOTE} ${RBAC_NOTE}`,
	request: { query: CallsQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: CallsOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const rates = createRoute({
	method: "get",
	path: "/rates",
	tags: ["AI Costs"],
	summary: "The effective rate table and which rates are still shipped defaults",
	description: `Amaldagi narxlar jadvali. isDefault — narx hech kim tomonidan tasdiqlanmagan. observedModels — ma'lumotda uchragan provayder/model juftliklari, ya'ni narx aslida qaysi modelga qo'llanayotgani; from/to berilsa faqat o'sha oraliqdagi sessiyalar bo'yicha. ${RBAC_NOTE}`,
	request: { query: RatesQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: RatesOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
