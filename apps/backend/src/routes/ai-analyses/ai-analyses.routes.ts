import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, IdParamSchema } from "@/lib";

import {
	ListOutSchema,
	ListQuerySchema,
	OneOutSchema,
	UpdateBodySchema,
} from "./ai-analyses.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["AI analyses"],
	summary: "List",
	description:
		"Qo'ng'iroqdan keyingi AI tahlillari (ai_analyses). Qo'ng'iroq va kontakt bilan birga qaytadi. " +
		"Filter: status, sentiment, hasSummary, callId, from/to (tahlil yaratilgan vaqti). " +
		"Manager: faqat o'zi olgan qo'ng'iroqlar tahlili. Admin/Supervisor: barchasi.",
	request: {
		query: ListQuerySchema,
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: ListOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const get = createRoute({
	method: "get",
	path: "/{id}",
	tags: ["AI analyses"],
	summary: "Get one",
	description:
		"To'liq tahlil: xulosa, kayfiyat, kategoriyalar, ishonch darajasi, saqlangan transkript matni " +
		"va callTranscripts jadvalidagi gap-bo'yicha qatorlar. Qo'lda tuzatilgan bo'lsa, oxirgi tuzatish " +
		"auditLogs'dan o'qib qaytariladi.",
	request: { params: IdParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: OneOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const update = createRoute({
	method: "patch",
	path: "/{id}",
	tags: ["AI analyses"],
	summary: "Correct by hand",
	description:
		"TZ 3.8 — AI xulosasini qo'lda tahrirlash. Faqat admin/supervisor. summary/sentiment/categories " +
		"o'zgartiriladi; qo'ng'iroq ticketga bog'langan bo'lsa, ticketdagi ai_* ustunlari ham yangilanadi. " +
		"Eski qiymatlar auditLogs details ichida saqlanadi (ai-analyses.correct).",
	request: {
		params: IdParamSchema,
		body: jsonContentRequired(UpdateBodySchema, "body"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: OneOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const retry = createRoute({
	method: "post",
	path: "/{id}/retry",
	tags: ["AI analyses"],
	summary: "Retry a failed analysis",
	description:
		"Xatolik bilan tugagan tahlilni qayta ishga tushiradi: saqlangan transkript OPENAI_ANALYSIS_MODEL'ga " +
		"yuboriladi va natija ai_analyses/calls/tickets ga yoziladi (retry_count +1). Transkript bo'lmasa yoki " +
		"mijoz gapi yozib olinmagan bo'lsa — 422 va aniq sabab qaytadi, xulosa O'YLAB TOPILMAYDI. " +
		"Faqat admin/supervisor.",
	request: { params: IdParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: OneOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
