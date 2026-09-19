import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, IdParamSchema } from "@/lib";

import {
	CancelOutSchema,
	CreateBodySchema,
	ListOutSchema,
	ListQuerySchema,
	OneOutSchema,
	UpdateBodySchema,
} from "./follow-ups.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Follow-ups"],
	summary: "List",
	description:
		"Manager: faqat o'ziga biriktirilgan vazifalar. Admin/Supervisor: barchasi. Filter: status, assignedTo, dueFrom/dueTo, overdue.",
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

export const create = createRoute({
	method: "post",
	path: "/",
	tags: ["Follow-ups"],
	summary: "Create",
	description:
		"Yangi follow-up vazifa (createdBySystem = false). Manager faqat o'ziga biriktira oladi; assignedTo berilmasa o'ziga biriktiriladi.",
	request: { body: jsonContentRequired(CreateBodySchema, "body") },
	responses: {
		[HttpStatusCodes.CREATED]: {
			content: { "application/json": { schema: OneOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const get = createRoute({
	method: "get",
	path: "/{id}",
	tags: ["Follow-ups"],
	summary: "Get one",
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
	tags: ["Follow-ups"],
	summary: "Update",
	description:
		"Status o'zgarishi tekshiriladi; status=done bo'lsa completedAt avtomatik yoziladi, done'dan chiqilsa tozalanadi. assignedTo'ni faqat admin/supervisor o'zgartiradi.",
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

export const remove = createRoute({
	method: "delete",
	path: "/{id}",
	tags: ["Follow-ups"],
	summary: "Cancel (soft)",
	description: "Qator o'chirilmaydi — status = cancelled qilinadi.",
	request: { params: IdParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: CancelOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
