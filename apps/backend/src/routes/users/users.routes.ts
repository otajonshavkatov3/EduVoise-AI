import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { commonResponses, IdParamSchema } from "@/lib";

import {
	ListOutSchema,
	ListQuerySchema,
	MyProfileOutSchema,
	OneOutSchema,
	RemoveOutSchema,
	UpdateBodySchema,
} from "./users.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Users"],
	summary: "List users (Supervisor)",
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
/**
 * Additive: har qanday rol o'z profilini o'qiy oladi (rol tekshiruvi yo'q,
 * chunki faqat o'zining yozuvini qaytaradi). `/{id}` bilan to'qnashmaydi —
 * yo'l ikki segmentli.
 */
export const getMyProfile = createRoute({
	method: "get",
	path: "/me/profile",
	tags: ["Users"],
	summary: "Get my own account profile",
	description:
		"Joriy foydalanuvchining o'z hisob ma'lumotlari: telefon, username, email, rol, oxirgi kirish vaqti va (mavjud bo'lsa) operator profili. Rol cheklovi yo'q — faqat so'rov yuborgan foydalanuvchining o'z yozuvi qaytariladi.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: MyProfileOutSchema } },
			description: "Joriy foydalanuvchi profili",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const get = createRoute({
	method: "get",
	path: "/{id}",
	tags: ["Users"],
	summary: "Get one user (Supervisor)",
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
	tags: ["Users"],
	summary: "Update user (Supervisor)",
	request: {
		params: IdParamSchema,
		body: {
			content: {
				"application/json": {
					schema: UpdateBodySchema,
				},
			},
		},
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
	tags: ["Users"],
	summary: "Soft delete user (Supervisor)",
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
