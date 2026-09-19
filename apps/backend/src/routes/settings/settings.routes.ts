import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses } from "@/lib";

import {
	GetOutSchema,
	TelegramTestBodySchema,
	TelegramTestOutSchema,
	UpdateBodySchema,
	UpdateOutSchema,
} from "./settings.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Settings"],
	summary: "Barcha sozlamalar",
	description:
		"Kategoriyalar bo'yicha guruhlangan sozlamalar. Maxfiy qiymatlar («secret») hech qachon ochiq qaytarilmaydi — o'rniga «***» keladi va `isSet` qiymat saqlanganini bildiradi. `canEdit` faqat supervisor uchun true.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: GetOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const update = createRoute({
	method: "patch",
	path: "/",
	tags: ["Settings"],
	summary: "Sozlamalarni saqlash",
	description:
		"Faqat supervisor. Har bir kalit registrda mavjud bo'lishi va qiymat uning sxemasidan o'tishi shart. Maxfiy maydonga «***» yuborilsa e'tiborsiz qoldiriladi (saqlangan qiymat o'zgarmaydi), bo'sh satr yuborilsa saqlangan qiymat o'chiriladi. Har bir o'zgarish auditga yoziladi (maxfiy qiymatlar yozilmaydi).",
	request: { body: jsonContentRequired(UpdateBodySchema, "body") },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: UpdateOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const testTelegram = createRoute({
	method: "post",
	path: "/test/telegram",
	tags: ["Settings"],
	summary: "Telegram sozlamalarini tekshirish",
	description:
		"Faqat supervisor. Token Telegram API (getMe) orqali tasdiqlanadi; chat ID berilgan bo'lsa haqiqiy test xabari yuboriladi. Hech narsa saqlanmaydi — body'da berilgan qiymatlar faqat shu tekshiruv uchun ishlatiladi, berilmasa saqlangan qiymatlar olinadi.",
	request: { body: jsonContentRequired(TelegramTestBodySchema, "body") },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: TelegramTestOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
