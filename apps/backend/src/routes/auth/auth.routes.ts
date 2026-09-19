import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses } from "@/lib";

import {
	AuthResponseSchema,
	ChangePasswordSchema,
	LoginSchema,
	MeResponseSchema,
	MessageResponseSchema,
	RefreshTokenSchema,
	RegisterSchema,
} from "./auth.schemas";

export const register = createRoute({
	method: "post",
	path: "/register",
	tags: ["Auth"],
	summary: "Register",
	description:
		"Yangi foydalanuvchi ro'yxatdan o'tkazish (telefon + parol). Bearer token talab qilinadi. Login kabi access va refresh token qaytaradi.",
	request: {
		body: jsonContentRequired(RegisterSchema, "Register payload"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: AuthResponseSchema,
				},
			},
			description: "Ro'yxatdan o'tdi va tokenlar qaytarildi",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const login = createRoute({
	method: "post",
	path: "/login",
	tags: ["Auth"],
	summary: "Login",
	description: "Telefon raqami va parol bilan tizimga kirish",
	request: {
		body: jsonContentRequired(LoginSchema, "Login credentials"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: AuthResponseSchema,
				},
			},
			description: "Muvaffaqiyatli kirish",
		},
		...commonResponses,
	},
});

export const refresh = createRoute({
	method: "post",
	path: "/refresh",
	tags: ["Auth"],
	summary: "Refresh tokens",
	description: "Refresh token yordamida yangi access va refresh tokenlarni olish",
	request: {
		body: jsonContentRequired(RefreshTokenSchema, "Refresh token"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: AuthResponseSchema,
				},
			},
			description: "Yangi tokenlar",
		},
		...commonResponses,
	},
});

export const logout = createRoute({
	method: "post",
	path: "/logout",
	tags: ["Auth"],
	summary: "Logout",
	description: "Tizimdan chiqish va refresh tokenni bekor qilish",
	request: {
		body: jsonContentRequired(RefreshTokenSchema, "Refresh token"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: MessageResponseSchema,
				},
			},
			description: "Muvaffaqiyatli chiqish",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const changePassword = createRoute({
	method: "post",
	path: "/change-password",
	tags: ["Auth"],
	summary: "Change password",
	description:
		"Joriy foydalanuvchi parolini o'zgartirish. Hozirgi parol tasdiqlanadi va " +
		"muvaffaqiyatli o'zgartirilgandan so'ng barcha qurilmalardagi sessiyalar " +
		"bekor qilinadi (qayta kirish talab etiladi).",
	request: {
		body: jsonContentRequired(ChangePasswordSchema, "Parolni o'zgartirish"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: MessageResponseSchema,
				},
			},
			description: "Parol o'zgartirildi",
		},
		...commonResponses,
	},
});

export const me = createRoute({
	method: "get",
	path: "/me",
	tags: ["Auth"],
	summary: "Get current user",
	description: "Joriy foydalanuvchi ma'lumotlarini olish",
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: MeResponseSchema,
				},
			},
			description: "Joriy foydalanuvchi",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
