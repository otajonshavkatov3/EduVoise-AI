import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { commonResponses, IdParamSchema } from "@/lib";

import { FullOutSchema, FullQuerySchema } from "./calls.full.schemas";
import {
	ExportQuerySchema,
	ListOutSchema,
	ListQuerySchema,
	MeStatsOutSchema,
	OneOutSchema,
} from "./calls.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Calls"],
	summary: "List calls",
	description:
		"Operator: faqat o'z qo'ng'iroqlari. Admin/Supervisor: barchasi. " +
		"Filter: phoneNumber, status, direction, operatorId, from, to, aiStatus, sentiment, hasRecording. " +
		"Har bir qator ro'yxat uchun kerakli qo'shimchalarni ham qaytaradi: operatorName, " +
		"operatorExtension, hasRecording, hasTranscript, sentiment va costUsd. " +
		"Narx faqat supervisor va admin uchun — /ai-costs bilan bir xil qoida; boshqa rollarda " +
		"costUsd=null va data.costVisible=false.",
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

export const missed = createRoute({
	method: "get",
	path: "/missed",
	tags: ["Calls"],
	summary: "List missed calls",
	description:
		"O'tkazib yuborilgan qo'ng'iroqlar ro'yxati. Operator: o'zini, Admin/Supervisor: barchasi.",
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

export const exportCalls = createRoute({
	method: "get",
	path: "/export",
	tags: ["Calls"],
	summary: "Export calls (CSV)",
	description:
		"List bilan bir xil filterlar. Natija: CSV fayl (text/csv). Avvalgi 15 ustun o'z tartibida " +
		"qoldi; oxiriga operatorName, hasRecording, hasTranscript, sentiment, costUsd qo'shildi.",
	request: {
		query: ExportQuerySchema,
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "text/csv": { schema: z.string() } },
			description: "CSV file",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const getMeStats = createRoute({
	method: "get",
	path: "/me/stats",
	tags: ["Calls"],
	summary: "Get current operator's today stats",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: MeStatsOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const get = createRoute({
	method: "get",
	path: "/{id}",
	tags: ["Calls"],
	summary: "Get one call",
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

export const getFull = createRoute({
	method: "get",
	path: "/{id}/full",
	tags: ["Calls"],
	summary: "Everything about one call in a single request",
	description:
		"Qo'ng'iroq sahifasi uchun to'liq ma'lumot: qo'ng'iroqning o'zi (kontakt va operator ismi bilan), " +
		"ovoz yozuvi, transkriptlar, AI tahlili, AI sessiyasi va tokenlar, xarajat, hamda qo'ng'iroqda " +
		"bajarilgan ishlar (ticket, uzatmalar, follow-up, bandlik, eslatmalar). " +
		"Operator faqat o'z qo'ng'irog'ini ochadi; boshqasiga 404 (403 emas). " +
		"Xarajat faqat supervisor va admin uchun — /ai-costs bilan bir xil qoida; boshqa rollarda " +
		"cost=null va costVisible=false. Narx o'qish paytida joriy narxlar bo'yicha hisoblanadi va " +
		"saqlanmaydi, hisoblab bo'lmagan qiymat null qaytadi (0 emas).",
	request: { params: IdParamSchema, query: FullQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: FullOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
