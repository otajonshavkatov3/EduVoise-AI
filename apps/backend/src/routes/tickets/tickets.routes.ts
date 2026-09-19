import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, IdParamSchema } from "@/lib";

import {
	CreateBodySchema,
	ListOutSchema,
	ListQuerySchema,
	OneOutSchema,
	RemoveOutSchema,
	UpdateBodySchema,
} from "./tickets.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Tickets"],
	summary: "List",
	description: "Operator: faqat o'z ticketlari. Admin/Supervisor: barchasi (filter ixtiyoriy).",
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
	tags: ["Tickets"],
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

export const create = createRoute({
	method: "post",
	path: "/",
	tags: ["Tickets"],
	summary: "Create",
	description: "Yangi ticket. createdBy = joriy foydalanuvchi.",
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

export const update = createRoute({
	method: "patch",
	path: "/{id}",
	tags: ["Tickets"],
	summary: "Update",
	description: "Operator: faqat o'z ticketi. Admin/Supervisor: istalgan.",
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
	tags: ["Tickets"],
	summary: "Soft delete",
	description: "Operator: faqat o'z ticketi. Admin/Supervisor: istalgan.",
	request: { params: IdParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: RemoveOutSchema,
				},
			},
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
