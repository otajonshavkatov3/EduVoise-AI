import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, IdParamSchema } from "@/lib";

import {
	CreateBodySchema,
	DeleteOutSchema,
	DetailOutSchema,
	ListOutSchema,
	OneOutSchema,
	UpdateBodySchema,
} from "./ai-agent.schemas";

const TAGS = ["AI Agent"];

export const listProfiles = createRoute({
	method: "get",
	path: "/profiles",
	tags: TAGS,
	summary: "Profillar ro'yxati",
	description:
		"Barcha profillar; aktiv profil birinchi keladi va `isActive` bilan belgilanadi (`activeProfileId` ham qaytariladi). Har bir profil uchun bilim bazasi yozuvlari soni ko'rsatiladi. O'qish barcha avtorizatsiyalangan foydalanuvchilar uchun ochiq.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: ListOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const getActive = createRoute({
	method: "get",
	path: "/profile",
	tags: TAGS,
	summary: "Aktiv profil",
	description:
		"Qo'ng'iroqlarga hozir javob berayotgan profil. Hech qanday profil bo'lmasa — standart profil avtomatik yaratiladi (ensureDefaultProfile), shuning uchun panelda hech qachon bo'sh forma ko'rinmaydi. `isOpenNow` — businessHours bo'yicha hozir ish vaqti ekanligi; ish vaqti server vaqtida hisoblanadi, `businessHours.tz` hozircha faqat saqlanadi.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: DetailOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const createProfile = createRoute({
	method: "post",
	path: "/profiles",
	tags: TAGS,
	summary: "Yangi profil (draft)",
	description:
		"Faqat supervisor/admin. Yangi profil draft sifatida yaratiladi — jonli qo'ng'iroqlarga javob berayotgan profil o'zgarmaydi (aktivlashtirish alohida endpoint orqali). Istisno: hech qanday aktiv profil bo'lmasa, yaratilgan profil darhol aktivlashtiriladi, aks holda AI umumiy standart sozlamalar bilan javob berib qolar edi. Berilmagan maydonlar uchun ehtiyotkor standart qiymatlar olinadi (unknownPolicy = transfer).",
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

export const updateProfile = createRoute({
	method: "patch",
	path: "/profiles/{id}",
	tags: TAGS,
	summary: "Profilni tahrirlash",
	description:
		"Faqat supervisor/admin. Berilgan maydonlargina o'zgaradi. Tekshiruvlar: `ticketCategories` — bo'sh bo'lmagan satrlardan iborat bo'sh bo'lmagan massiv (takrorlanmasligi shart), `transferExtensions` — ichki raqamlar (faqat raqam, 2..10 belgi), `unknownPolicy` — transfer | take_message | say_unknown, `businessHours` — { tz?, days: { mon: [[\"09:00\",\"18:00\"]] } } (noma'lum kun kalitlari rad etiladi; kun kaliti bo'sh massiv bo'lsa — o'sha kun yopiq). `unknownPolicy=transfer` bo'lganda `transferExtensions` bo'sh qolmasligi kerak — aks holda agent bajarilmaydigan va'da bergan bo'lardi. O'zgarishdan keyin profil keshi tozalanadi, ya'ni keyingi qo'ng'iroq yangi sozlamani eshitadi.",
	request: {
		params: IdParamSchema,
		body: jsonContentRequired(UpdateBodySchema, "body"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: DetailOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const activate = createRoute({
	method: "post",
	path: "/profiles/{id}/activate",
	tags: TAGS,
	summary: "Profilni aktivlashtirish",
	description:
		"Faqat supervisor/admin. Shu profil qo'ng'iroqlarga javob beradigan yagona profilga aylanadi (oldingisi avtomatik draft bo'ladi). Kesh tozalanadi — keyingi qo'ng'iroq allaqachon yangi profil bilan boshlanadi.",
	request: { params: IdParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: DetailOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const removeProfile = createRoute({
	method: "delete",
	path: "/profiles/{id}",
	tags: TAGS,
	summary: "Profilni o'chirish",
	description:
		"Faqat supervisor/admin. Aktiv profil o'chirilmaydi — telefon liniyasi javobsiz qolmasligi uchun avval boshqa profil aktivlashtiriladi. Profil bilan birga uning bilim bazasi yozuvlari ham o'chadi (cascade), o'chgan yozuvlar soni javobda va auditda ko'rsatiladi.",
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
