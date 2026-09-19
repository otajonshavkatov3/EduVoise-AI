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
	SipIdentityOutSchema,
	UpdateBodySchema,
	UpdateStatusSchema,
} from "./operator-profiles.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Operator Profiles"],
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

export const getMe = createRoute({
	method: "get",
	path: "/me/profile",
	tags: ["Operator Profiles"],
	summary: "Get my own operator profile",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: OneOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const getMeSip = createRoute({
	method: "get",
	path: "/me/sip",
	tags: ["Operator Profiles"],
	summary: "Get my own browser-softphone SIP credentials",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: SipIdentityOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const get = createRoute({
	method: "get",
	path: "/{id}",
	tags: ["Operator Profiles"],
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
	tags: ["Operator Profiles"],
	summary: "Create (Supervisor)",
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

export const updateMeStatus = createRoute({
	method: "patch",
	path: "/me/status",
	tags: ["Operator Profiles"],
	summary: "Update my own status",
	request: {
		body: jsonContentRequired(UpdateStatusSchema, "body"),
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

export const update = createRoute({
	method: "patch",
	path: "/{id}",
	tags: ["Operator Profiles"],
	summary: "Update (extension, status) — Supervisor",
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
	tags: ["Operator Profiles"],
	summary: "Soft delete (Supervisor)",
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
