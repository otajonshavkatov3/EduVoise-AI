import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, IdParamSchema } from "@/lib";

import {
	CreateBodySchema,
	ListOutSchema,
	ListQuerySchema,
	LookupOutSchema,
	LookupQuerySchema,
	OneOutSchema,
	RemoveOutSchema,
	UpdateBodySchema,
} from "./contacts.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Contacts"],
	summary: "List",
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
	tags: ["Contacts"],
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
	tags: ["Contacts"],
	summary: "Create",
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
	tags: ["Contacts"],
	summary: "Update",
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
	tags: ["Contacts"],
	summary: "Soft delete (Admin/Supervisor)",
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

export const lookup = createRoute({
	method: "get",
	path: "/lookup",
	tags: ["Contacts"],
	summary: "Caller ID lookup by phone number",
	request: {
		query: LookupQuerySchema,
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: LookupOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
