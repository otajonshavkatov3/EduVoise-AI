import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, IdParamSchema } from "@/lib";

import {
	BulkBodySchema,
	BulkOutSchema,
	CreateBodySchema,
	DeleteOutSchema,
	ListOutSchema,
	ListQuerySchema,
	OneOutSchema,
	SearchBodySchema,
	SearchOutSchema,
	StatsOutSchema,
	StatsQuerySchema,
	UpdateBodySchema,
} from "./knowledge-base.schemas";

const TAGS = ["Knowledge Base"];

export const list = createRoute({
	method: "get",
	path: "/",
	tags: TAGS,
	summary: "Yozuvlar ro'yxati",
	description:
		"Sahifalangan ro'yxat. Filtrlar: `profileId` (berilmasa aktiv profil), `q` (savol + javob + teglar bo'yicha matn izlash), `tag` (aynan shu teg), `isActive`. Tartib: priority (yuqorisi avval), keyin yangi yaratilgani. O'qish barcha avtorizatsiyalangan foydalanuvchilar uchun ochiq.",
	request: { query: ListQuerySchema },
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
	tags: TAGS,
	summary: "Yangi yozuv",
	description:
		"Faqat supervisor/admin. `profileId` berilmasa aktiv profilga yoziladi (profil bo'lmasa standart profil yaratiladi). Bir profil ichida aynan bir xil savol ikki marta saqlanmaydi — takrori mavjud yozuv id'si bilan qaytariladi.",
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

export const bulk = createRoute({
	method: "post",
	path: "/bulk",
	tags: TAGS,
	summary: "Ko'p yozuvni import qilish",
	description:
		"Faqat supervisor/admin. Biznes tayyor FAQ ro'yxati bilan keladi — bitta chaqiriqda 200 tagacha yozuv. Import qator-baqator ketadi va bitta xato butun importni to'xtatmaydi: har bir qator uchun `created` | `skipped` | `failed` va sabab qaytariladi. Takrorlangan savol (payload ichida yoki bazada allaqachon bor) `skipped` bo'ladi, shuning uchun bir xil ro'yxatni ikki marta yuborish nusxa yaratmaydi. Bironta yozuv yaratilsa 201, hech biri yaratilmasa 200 qaytadi.",
	request: { body: jsonContentRequired(BulkBodySchema, "body") },
	responses: {
		[HttpStatusCodes.CREATED]: {
			content: { "application/json": { schema: BulkOutSchema } },
			description: "Kamida bitta yozuv yaratildi",
		},
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: BulkOutSchema } },
			description: "Hech qanday yozuv yaratilmadi (hammasi skipped/failed)",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const search = createRoute({
	method: "post",
	path: "/search",
	tags: TAGS,
	summary: "Qidiruvni sinash",
	description:
		"Haqiqiy qo'ng'iroqdagi qidiruvning o'zi: `searchKnowledgeBase` aktiv profil bo'yicha ishlatiladi (`profileId` berilsa — draft profilni ham sinash mumkin). Egasiga «AI bu javobni topadimi?» degan savolga haqiqiy qo'ng'iroqdan oldin javob beradi. Natija bo'sh bo'lsa `wouldAnswer=false` va `fallbackAction` — agent o'rniga nima qilishi (profilning unknownPolicy'si bo'yicha). Diqqat: bu ham haqiqiy qidiruv, shuning uchun eng mos yozuvning `useCount` hisoblagichi oshadi — statistikada sinov so'rovlar ham ko'rinadi.",
	request: { body: jsonContentRequired(SearchBodySchema, "body") },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: SearchOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const stats = createRoute({
	method: "get",
	path: "/stats",
	tags: TAGS,
	summary: "Statistika",
	description:
		"Yozuvlar soni, nechtasi yoqilgan, hech qachon ishlatilmaganlari va eng ko'p ishlatilgan yozuvlar (`useCount` / `lastUsedAt`) — ya'ni qo'ng'iroq qiluvchilar aslida nimani so'rashi. `profileId` berilmasa aktiv profil olinadi.",
	request: { query: StatsQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: StatsOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const get = createRoute({
	method: "get",
	path: "/{id}",
	tags: TAGS,
	summary: "Bitta yozuv",
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
	tags: TAGS,
	summary: "Yozuvni tahrirlash",
	description:
		"Faqat supervisor/admin. Savol o'zgartirilsa shu profildagi boshqa yozuvlar bilan takrorlanmasligi tekshiriladi. `isActive=false` — yozuv qidiruvdan chiqadi, ya'ni agent uni aytmaydi (o'chirmasdan vaqtincha to'xtatish uchun).",
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
	tags: TAGS,
	summary: "Yozuvni o'chirish",
	description:
		"Faqat supervisor/admin. Bu kontent, tarix emas — qator butunlay o'chiriladi. Nima o'chirilgani (savol, javob uzunligi, ishlatilish soni) auditga yoziladi. Yozuvni saqlab qo'yib, faqat agent aytmasligini xohlasangiz — `isActive=false` ishlatiladi.",
	request: { params: IdParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: DeleteOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
