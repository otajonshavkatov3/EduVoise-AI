import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, IdParamSchema } from "@/lib";
import { EARLIEST_CALL_TIME, LATEST_CALL_TIME } from "@/lib/campaigns";

import {
	CreateBodySchema,
	DeleteOutSchema,
	DncCreateBodySchema,
	DncCreateOutSchema,
	DncListOutSchema,
	DncListQuerySchema,
	ImportBodySchema,
	ImportOutSchema,
	LeadListOutSchema,
	LeadListQuerySchema,
	LeadOneOutSchema,
	LeadParamSchema,
	LeadUpdateBodySchema,
	LeadUpdateOutSchema,
	ListOutSchema,
	ListQuerySchema,
	MAX_IMPORT_ROWS,
	OneOutSchema,
	ProgressOutSchema,
	StartOutSchema,
	UpdateBodySchema,
} from "./campaigns.schemas";

const TAGS = ["Campaigns"];

/**
 * The three sentences that explain this whole group, repeated into the OpenAPI
 * descriptions because that is where an integrator reads them.
 */
const MANAGE_NOTE =
	"Faqat supervisor/admin: kampaniyani ishga tushirish pul sarflaydi va haqiqiy odamlarga " +
	"qo'ng'iroq qiladi, shuning uchun ruxsat /ai-costs sahifasi bilan bir xil chegaralangan.";
const READ_NOTE = "O'qish barcha avtorizatsiyalangan foydalanuvchilar uchun ochiq.";
const TRUNK_NOTE =
	"DIQQAT: .env dagi SIP_TRUNK_HOST bo'sh bo'lsa tashqi (mobil) raqamlarga qo'ng'iroq " +
	"ketmaydi — faqat ichki raqamlar (101–104, 201–204) teriladi. Javobdagi `dialing` bo'limi " +
	"shuni aniq aytadi.";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: TAGS,
	summary: "Kampaniyalar ro'yxati",
	description: `Sahifalangan ro'yxat. Filtrlar: \`status\`, \`kind\`, \`q\` (nom va maqsad matni). Tartib: ishlayotganlar avval, keyin yangilari. Har bir qatorda ro'yxatdagi raqamlar soni va navbatda qolganlar bor. ${READ_NOTE}`,
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
	summary: "Yangi kampaniya (qoralama)",
	description:
		`${MANAGE_NOTE} Kampaniya «qoralama» holatida yaratiladi — hech kimga qo'ng'iroq qilinmaydi, ` +
		`avval ro'yxat import qilinadi va keyin ishga tushiriladi. \`purpose\` majburiy: bu AI ` +
		`qo'ng'iroq boshida aytadigan sabab, chunki odam bu qo'ng'iroqni o'zi so'ramagan. ` +
		`Qo'ng'iroq oynasi (\`callWindowStart\`/\`callWindowEnd\`) tashkilot vaqt mintaqasi bo'yicha ` +
		`baholanadi va ${EARLIEST_CALL_TIME}–${LATEST_CALL_TIME} orasida bo'lishi shart.`,
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

export const listDnc = createRoute({
	method: "get",
	path: "/dnc",
	tags: TAGS,
	summary: "«Qo'ng'iroq qilinmasin» ro'yxati",
	description: `Har bir dial shu ro'yxatdan o'tadi. \`source\`: \`asked_on_call\` — odam qo'ng'iroq vaqtida o'zi so'ragan (o'chirilmaydi), \`manual\` / \`import\` — qo'lda kiritilgan. ${READ_NOTE}`,
	request: { query: DncListQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: DncListOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const createDnc = createRoute({
	method: "post",
	path: "/dnc",
	tags: TAGS,
	summary: "Raqamni «qo'ng'iroq qilinmasin» ro'yxatiga qo'shish",
	description:
		`${MANAGE_NOTE} Bir yoki bir nechta raqam yuborish mumkin (${MAX_IMPORT_ROWS} tagacha). ` +
		"Takror qo'shish xatolik emas — birinchi yozuv (va odam aytgan sabab) saqlanib qoladi, " +
		"javobda `existing` bo'lib qaytadi. Qo'shilgan raqam barcha kampaniyalarning navbatidan " +
		"darhol chiqariladi; nechta yozuv chiqarilgani `leadsSkipped` da.",
	request: { body: jsonContentRequired(DncCreateBodySchema, "body") },
	responses: {
		[HttpStatusCodes.CREATED]: {
			content: { "application/json": { schema: DncCreateOutSchema } },
			description: "Kamida bitta yangi raqam qo'shildi",
		},
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: DncCreateOutSchema } },
			description: "Yangi raqam qo'shilmadi (hammasi ro'yxatda bor edi yoki xato)",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const removeDnc = createRoute({
	method: "delete",
	path: "/dnc/{id}",
	tags: TAGS,
	summary: "«Qo'ng'iroq qilinmasin» yozuvini o'chirish",
	description:
		"Faqat admin. Odamning o'zi qo'ng'iroq vaqtida so'ragan yozuv (`asked_on_call`) HECH QACHON " +
		"o'chirilmaydi — aks holda bu himoya shunchaki tavsiyaga aylanadi. Qo'lda yoki import bilan " +
		"kiritilgan yozuv xato bo'lishi mumkin (masalan noto'g'ri raqam), shuning uchun ular " +
		"o'chiriladi va o'chirilgani auditga yoziladi.",
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

export const get = createRoute({
	method: "get",
	path: "/{id}",
	tags: TAGS,
	summary: "Bitta kampaniya",
	description: READ_NOTE,
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
	summary: "Kampaniyani tahrirlash",
	description:
		`${MANAGE_NOTE} Ishlayotgan kampaniyani ham tahrirlash mumkin — masalan qo'ng'iroq oynasini ` +
		"qisqartirish yoki bir vaqtdagi qo'ng'iroqlar sonini kamaytirish kampaniyani bekor " +
		"qilmasdan bajarilishi kerak. Tugagan va bekor qilingan kampaniya tahrirlanmaydi: uning " +
		"natijalari o'sha paytdagi maqsad va oyna bo'yicha yozilgan.",
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
	summary: "Kampaniyani o'chirish (faqat qoralama)",
	description:
		`${MANAGE_NOTE} Faqat «qoralama» holatidagi kampaniya o'chiriladi. Ishga tushgan kampaniya ` +
		"qo'ng'iroqlar tarixining bir qismi: uning yozuvlari `calls` qatorlariga (transkript, " +
		"ovoz yozuvi, narx) bog'langan va kampaniyaning o'zi o'sha qo'ng'iroqlar nega bo'lganini " +
		"tushuntiradi. Uni to'xtatish uchun «bekor qilish» ishlatiladi.",
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

export const start = createRoute({
	method: "post",
	path: "/{id}/start",
	tags: TAGS,
	summary: "Ishga tushirish (qoralama yoki pauzadan)",
	description:
		`${MANAGE_NOTE} Ruxsat etilgan o'tishlar: qoralama → ishlayapti, pauza → ishlayapti. ` +
		"Boshqa har qanday holat o'zbekcha sabab bilan rad etiladi (masalan bekor qilingan " +
		"kampaniya qayta ishga tushmaydi). Navbatda birorta raqam bo'lmasa ham rad etiladi. " +
		`${TRUNK_NOTE} Trunk yo'q va ro'yxatda faqat tashqi raqamlar bo'lsa — ishga tushirilmaydi, ` +
		"chunki har bir qator xatolik bilan tugardi. Qo'ng'iroq oynasi hozir yopiq bo'lsa " +
		"kampaniya ishga tushadi, lekin qo'ng'iroqlar oyna ochilganda boshlanadi — bu javobdagi " +
		"`warnings` da aytiladi.",
	request: { params: IdParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: StartOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const pause = createRoute({
	method: "post",
	path: "/{id}/pause",
	tags: TAGS,
	summary: "Pauza",
	description:
		`${MANAGE_NOTE} Faqat «ishlayapti» holatidan. Yangi qo'ng'iroqlar boshlanmaydi; hozir ` +
		"davom etayotgan qo'ng'iroqlar o'z tabiiy yakuniga yetadi. Keyin yana ishga tushirish mumkin.",
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

export const cancel = createRoute({
	method: "post",
	path: "/{id}/cancel",
	tags: TAGS,
	summary: "Bekor qilish (qaytarilmaydi)",
	description:
		`${MANAGE_NOTE} Qoralama, ishlayotgan yoki pauzadagi kampaniyani bekor qiladi. Bu holat ` +
		"qaytarilmaydi: bekor qilingan kampaniya qayta ishga tushmaydi, chunki uning yozuvlarida " +
		"birinchi urinishning natijalari turadi va qayta yurgizish allaqachon javob bergan " +
		"odamlarga ikkinchi marta qo'ng'iroq qilardi. Kim va qachon bekor qilgani saqlanadi.",
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

export const importLeads = createRoute({
	method: "post",
	path: "/{id}/leads/import",
	tags: TAGS,
	summary: "Raqamlar ro'yxatini import qilish",
	description:
		`${MANAGE_NOTE} Ikki ko'rinishdan bittasi yuboriladi: \`text\` (bir textarea'ga qo'yilgan ` +
		"ro'yxat — tab, nuqtali vergul yoki vergul bilan; sarlavha qatori bo'lsa avtomatik " +
		"aniqlanadi) yoki `rows` (tayyor massiv). Birinchi ustun — raqam. Sarlavha bo'lsa " +
		"qolgan ustunlar shu nom bilan «o'zgaruvchi» bo'ladi va ularni `purpose` matnida " +
		"ishlatish mumkin (masalan `qarz`, `sana`) — shuning uchun har bir qo'ng'iroq bir xil " +
		"gapni aytmaydi. Sarlavha bo'lmasa ikkinchi ustun — ism, keyingilari `var1`, `var2` " +
		"(yoki `kalit=qiymat` ko'rinishida yozilsa o'z nomi bilan).\n\n" +
		"Import BUTUNLAY to'xtamaydi: har bir qator uchun alohida natija qaytadi — `created` " +
		"yoki `skipped`/`failed` va sababi. Sabablar: `invalid_number` (raqam formati), " +
		"`duplicate_in_file` (bir fayl ichida takrorlangan), `already_in_campaign` (shu " +
		"kampaniyada bor), `do_not_call` («qo'ng'iroq qilinmasin» ro'yxatida). " +
		"Raqamlar bitta ko'rinishga keltirib saqlanadi: faqat sonlar, davlat kodi bilan " +
		"(998905706507); ichki raqamlar uch xonali bo'lib qoladi (201). Mavjud kontakt " +
		"topilsa bog'lanadi, lekin yangi kontakt YARATILMAYDI." +
		`\n\n${MAX_IMPORT_ROWS} tadan ko'p qator yuborilsa birinchi ${MAX_IMPORT_ROWS} tasi olinadi va \`parsed.truncated\` true bo'ladi.`,
	request: {
		params: IdParamSchema,
		body: jsonContentRequired(ImportBodySchema, "body"),
	},
	responses: {
		[HttpStatusCodes.CREATED]: {
			content: { "application/json": { schema: ImportOutSchema } },
			description: "Kamida bitta raqam qo'shildi",
		},
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: ImportOutSchema } },
			description: "Birorta raqam qo'shilmadi (hammasi skipped/failed)",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const listLeads = createRoute({
	method: "get",
	path: "/{id}/leads",
	tags: TAGS,
	summary: "Kampaniya ro'yxati (raqamlar)",
	description:
		`Sahifalangan ro'yxat. Filtrlar: \`status\` (navbat holati), \`outcome\` (qo'ng'iroq ` +
		"natijasi), `q` (raqam yoki ism), `hasCall`. Tartib — dialer navbatni qanday " +
		`o'tsa shunday: vaqti kelganlar avval. ${READ_NOTE}`,
	request: {
		params: IdParamSchema,
		query: LeadListQuerySchema,
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: LeadListOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const getLead = createRoute({
	method: "get",
	path: "/{id}/leads/{leadId}",
	tags: TAGS,
	summary: "Bitta yozuv va uning barcha urinishlari",
	description:
		"Har bir urinish alohida qo'ng'iroq: `callId` bo'yicha /calls/:id kartasida transkript, " +
		`ovoz yozuvi va narx bor. ${READ_NOTE}`,
	request: { params: LeadParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: LeadOneOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const updateLead = createRoute({
	method: "patch",
	path: "/{id}/leads/{leadId}",
	tags: TAGS,
	summary: "Yozuvni tahrirlash: izoh, natija, navbatga qaytarish",
	description:
		`${MANAGE_NOTE} \`note\` — izoh. \`outcome\` — natijani qo'lda yozish (masalan operator ` +
		"o'zi qo'ng'iroq qildi): urinishlar soni oshmaydi, lekin natija dialer yozganidek " +
		"hisoblanadi va `do_not_call` natijasi raqamni «qo'ng'iroq qilinmasin» ro'yxatiga " +
		"qo'shadi. `action=requeue` — navbatga qaytarish (natija tozalanadi; raqam " +
		"«qo'ng'iroq qilinmasin» ro'yxatiga tushgan bo'lsa rad etiladi). `action=skip` — " +
		"bu raqamga qo'ng'iroq qilinmasin (shu kampaniya ichida). Hozir qo'ng'iroq " +
		"qilinayotgan yozuv o'zgartirilmaydi — istisno: dialer to'xtab qolib yozuv 10 " +
		"daqiqadan ortiq «calling» holatida qotib qolgan bo'lsa, uni navbatga qaytarish mumkin.",
	request: {
		params: LeadParamSchema,
		body: jsonContentRequired(LeadUpdateBodySchema, "body"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: LeadUpdateOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const progress = createRoute({
	method: "get",
	path: "/{id}/progress",
	tags: TAGS,
	summary: "Kampaniya holati: navbat, natijalar, xarajat, vaqt oynasi",
	description:
		"Navbat kesimi (`pending`/`calling`/`done`/`failed`/`skipped`), natijalar kesimi, " +
		"urinishlar soni va vaqt oynasining hozirgi holati. Xarajat /ai-costs bilan BIR XIL " +
		"kodda (lib/ai-cost) hisoblanadi va bazada saqlanmaydi — narxni tuzatish bu sahifani " +
		"ham qayta narxlaydi; hisoblab bo'lmagan qiymat null (0 emas). Xarajatni faqat " +
		"supervisor va admin ko'radi (`spend.visible=false` — rol ko'rmaydi), bu /ai-costs va " +
		`/calls/:id/full bilan bir xil qoida. ${TRUNK_NOTE} ${READ_NOTE}`,
	request: { params: IdParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: ProgressOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
