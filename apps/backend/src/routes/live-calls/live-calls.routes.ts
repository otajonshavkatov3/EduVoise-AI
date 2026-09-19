import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { commonResponses, IdParamSchema } from "@/lib";

import { LiveCallOneOutSchema, LiveCallsOutSchema, OneQuerySchema } from "./live-calls.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Live calls"],
	summary: "Currently active calls",
	description:
		"Orchestrator kuzatayotgan jonli qo'ng'iroqlar: kontakt, AI sessiya holati va davomiylik. " +
		"Operator (manager) faqat o'ziga tegishlilarini ko'radi — calls.operator_id o'zi bo'lgan yoki " +
		"o'z extensioniga uzatilgan qo'ng'iroqlar. Admin/Supervisor barchasini ko'radi.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: LiveCallsOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const get = createRoute({
	method: "get",
	path: "/{id}",
	tags: ["Live calls"],
	summary: "One live call with its latest transcript lines",
	description:
		"Jonli qo'ng'iroq + oxirgi transkript qatorlari (xronologik tartibda). " +
		"Qo'ng'iroq jonli bo'lmasa yoki operatorga tegishli bo'lmasa 404 qaytadi.",
	request: {
		params: IdParamSchema,
		query: OneQuerySchema,
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: LiveCallOneOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
