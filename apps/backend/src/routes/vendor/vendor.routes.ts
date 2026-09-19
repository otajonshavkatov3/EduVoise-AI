import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { commonResponses } from "@/lib";

import { EnterBodySchema, EnterOutSchema, ListOutSchema } from "./vendor.schemas";

export const listTenants = createRoute({
	method: "get",
	path: "/tenants",
	tags: ["Vendor"],
	summary: "Mijozlar ro'yxati (faqat platforma egasi)",
	description:
		"Platforma egasi uchun: barcha mijozlar. Maxfiy maydonlar (AI kaliti, trunk paroli) qaytarilmaydi.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: ListOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const enterTenant = createRoute({
	method: "post",
	path: "/tenants/{tenantId}/enter",
	tags: ["Vendor"],
	summary: "Mijoz hisobiga kirish (faqat platforma egasi)",
	description:
		"Platforma egasi mijoz hisobi ichida ishlash uchun qisqa muddatli token oladi. " +
		"Har bir so'rov audit logga yoziladi va mijoz o'z audit sahifasida ko'radi.",
	request: {
		params: z.object({ tenantId: z.string().uuid() }),
		body: {
			required: false,
			content: { "application/json": { schema: EnterBodySchema } },
		},
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: EnterOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
