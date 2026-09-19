import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, IdParamSchema } from "@/lib";

import {
	AppendBodySchema,
	CallIdParamSchema,
	ExportQuerySchema,
	ListOutSchema,
	ListQuerySchema,
	OneOutSchema,
	UpdateBodySchema,
} from "./transcripts.schemas";

export const listByCall = createRoute({
	method: "get",
	path: "/call/{callId}",
	tags: ["Transcripts"],
	summary: "List transcript lines of a call",
	description:
		"Qo'ng'iroq transkripti vaqt bo'yicha tartiblangan. Manager: faqat o'ziga tegishli qo'ng'iroq. Admin/Supervisor: barchasi.",
	request: {
		params: CallIdParamSchema,
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

export const exportByCall = createRoute({
	method: "get",
	path: "/call/{callId}/export",
	tags: ["Transcripts"],
	summary: "Export transcript (txt or CSV)",
	description:
		"Transkriptni fayl sifatida yuklab olish. format=txt — [mm:ss] role: matn ko'rinishida, format=csv — jadval.",
	request: {
		params: CallIdParamSchema,
		query: ExportQuerySchema,
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"text/plain": { schema: z.string() },
				"text/csv": { schema: z.string() },
			},
			description: "Transcript file",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const append = createRoute({
	method: "post",
	path: "/call/{callId}",
	tags: ["Transcripts"],
	summary: "Append a manual transcript line",
	description:
		"Qo'lda qo'shilgan/tuzatilgan qator. auditLogs'ga yoziladi (transcripts.append). AI sessiya topilsa, qator shu sessiyaga bog'lanadi.",
	request: {
		params: CallIdParamSchema,
		body: jsonContentRequired(AppendBodySchema, "body"),
	},
	responses: {
		[HttpStatusCodes.CREATED]: {
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
	tags: ["Transcripts"],
	summary: "Correct a transcript line",
	description:
		"Qatorni tuzatish. Eski matn auditLogs details ichida saqlanadi (transcripts.correct).",
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
