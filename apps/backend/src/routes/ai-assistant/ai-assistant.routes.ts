import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, IdParamSchema } from "@/lib";

import {
	AiConfigOutSchema,
	AiStatusOutSchema,
	SessionOneOutSchema,
	SessionsOutSchema,
	SessionsQuerySchema,
	UpdateConfigBodySchema,
	UpdateConfigOutSchema,
	VoicePreviewBodySchema,
	VoicePreviewOutSchema,
} from "./ai-assistant.schemas";

export const status = createRoute({
	method: "get",
	path: "/status",
	tags: ["AI assistant"],
	summary: "Voice provider health",
	description:
		"probeProviderHealth() natijasi: qaysi provider keyingi qo'ng'iroqni oladi, Realtime sessiya " +
		"ochish mumkinmi va nima uchun. Natija 30 sekund keshlanadi. OPENAI_API_KEY hech qachon " +
		"qaytarilmaydi — faqat `apiKeyConfigured` flagi.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: AiStatusOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const getConfig = createRoute({
	method: "get",
	path: "/config",
	tags: ["AI assistant"],
	summary: "Effective AI configuration (no secrets)",
	description:
		"Amaldagi konfiguratsiya. Ustunlik tartibi: biznes profili (ovoz, til va ikki chegara uchun) → " +
		"system_settings dagi «ai» sozlamalari → .env → kodagi standart qiymat. `sources` har bir " +
		"maydonning manbasini («profile» / «override» / «env»), `overrides` esa .env dan farq qiladigan " +
		"qiymatni ko'rsatadi. `notes` — maydon nimani O'ZGARTIRMAYDI (masalan dialplan talab qiladigan " +
		"joylar), `options` esa select'lar uchun yopiq ro'yxatlar. `restartRequiredFor` odatda bo'sh: " +
		"bu endpoint yozadigan har bir qiymat keyingi qo'ng'iroqda qaytadan o'qiladi.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: AiConfigOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const updateConfig = createRoute({
	method: "patch",
	path: "/config",
	tags: ["AI assistant"],
	summary: "Change AI configuration (Supervisor)",
	description:
		"Yuborilgan maydonlarni saqlaydi va keyingi qo'ng'iroqdan boshlab kuchga kiritadi — backend " +
		"restarti kerak emas, qiymat restartdan keyin ham saqlanib qoladi. Saqlash joyi: ovoz, til va " +
		"qo'ng'iroq chegaralari faol biznes profili yozuvida (chunki qo'ng'iroqda aynan shu qiymatlar " +
		"o'qiladi), qolganlari system_settings dagi «ai» kategoriyasida. .env fayli hech qachon " +
		"qayta yozilmaydi — u faqat boshlang'ich qiymat manbasi bo'lib qoladi. Ishlamaydigan qiymat " +
		"(masalan «live» so'zi yo'q Gemini modeli yoki boshqa provayderning ovozi) 400 bilan " +
		"o'zbekcha izoh qaytaradi. Audit log yoziladi.",
	request: { body: jsonContentRequired(UpdateConfigBodySchema, "body") },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: UpdateConfigOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const voicePreview = createRoute({
	method: "post",
	path: "/voice-preview",
	tags: ["AI assistant"],
	summary: "Hear one voice before choosing it (Supervisor)",
	description:
		"Bitta jumlani tanlangan ovozda o'qib, WAV (base64) qaytaradi — ovozni tanlashdan oldin " +
		"eshitish uchun. Matn berilmasa faol biznes profilining salomlashish matni o'qiladi. " +
		"MUHIM: namuna Google'ning TTS modeli (gemini-2.5-flash-preview-tts) orqali tayyorlanadi, " +
		"jonli suhbat modeli orqali emas — ovoz aynan o'sha ovoz, lekin sheva va nutq " +
		"sozlamalari (temperature, VAD) namunada ko'rinmaydi. Natija xotirada keshlanadi, chunki " +
		"Google bu modelga daqiqasiga 10 ta so'rov chekloviga ega; chekka yetilganda 429 va " +
		"qancha kutish kerakligi qaytadi.",
	request: { body: jsonContentRequired(VoicePreviewBodySchema, "body") },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: VoicePreviewOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const listSessions = createRoute({
	method: "get",
	path: "/sessions",
	tags: ["AI assistant"],
	summary: "List AI sessions",
	description:
		"ai_sessions + qo'ng'iroq va kontakt ma'lumotlari. Filter: status, provider, callId, from, to. " +
		"Operator (manager) faqat o'ziga tegishli qo'ng'iroqlar sessiyalarini ko'radi.",
	request: { query: SessionsQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: SessionsOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const getSession = createRoute({
	method: "get",
	path: "/sessions/{id}",
	tags: ["AI assistant"],
	summary: "One AI session with its full transcript",
	request: { params: IdParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: SessionOneOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
