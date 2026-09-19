import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, errorResponse, IdParamSchema } from "@/lib";

import {
	CalendarOutSchema,
	CalendarQuerySchema,
	CancelOutSchema,
	CreateBodySchema,
	ListOutSchema,
	ListQuerySchema,
	OneOutSchema,
	UpdateBodySchema,
} from "./bookings.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Bookings"],
	summary: "List",
	description:
		"Manager: faqat o'ziga biriktirilgan uchrashuvlar. Admin/Supervisor: barchasi. Filter: status, assignedTo, from/to (scheduledAt).",
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

export const calendar = createRoute({
	method: "get",
	path: "/calendar",
	tags: ["Bookings"],
	summary: "Calendar view (month/week)",
	description:
		"Dashboard kalendari uchun kunlar bo'yicha guruhlangan ro'yxat. Oraliqdagi har bir kun qaytadi (bo'sh kunlar ham). Guruhlash UTC bo'yicha.",
	request: {
		query: CalendarQuerySchema,
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: CalendarOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const create = createRoute({
	method: "post",
	path: "/",
	tags: ["Bookings"],
	summary: "Create",
	description:
		"Yangi uchrashuv (createdBySystem = false). O'tgan vaqt qabul qilinmaydi (422). Xodimning shu vaqt oralig'ida boshqa uchrashuvi bo'lsa 409.",
	request: { body: jsonContentRequired(CreateBodySchema, "body") },
	responses: {
		[HttpStatusCodes.CREATED]: {
			content: { "application/json": { schema: OneOutSchema } },
			description: "",
		},
		[HttpStatusCodes.CONFLICT]: errorResponse("Double-booking — xodim bu vaqtda band"),
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const get = createRoute({
	method: "get",
	path: "/{id}",
	tags: ["Bookings"],
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
	tags: ["Bookings"],
	summary: "Update",
	description:
		"Vaqt/davomiylik/xodim o'zgarsa double-booking va o'tgan vaqt qaytadan tekshiriladi. assignedTo'ni faqat admin/supervisor o'zgartiradi.",
	request: {
		params: IdParamSchema,
		body: jsonContentRequired(UpdateBodySchema, "body"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: OneOutSchema } },
			description: "",
		},
		[HttpStatusCodes.CONFLICT]: errorResponse("Double-booking — xodim bu vaqtda band"),
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const remove = createRoute({
	method: "delete",
	path: "/{id}",
	tags: ["Bookings"],
	summary: "Cancel",
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
