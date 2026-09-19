import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { commonResponses } from "@/lib";

import {
	DashboardCallVolumeSchema,
	DashboardMissedCallsSchema,
	DashboardOverviewSchema,
	DashboardSummarySchema,
	MissedCallsQuerySchema,
	PeriodQuerySchema,
} from "./dashboard.schemas";

/**
 * MAVJUD endpoint — yo'l, so'rov va javob shakli o'zgarmadi (autentifikatsiya
 * ham qo'shilmadi, chunki uni talab qilish mavjud chaqiruvchilarni buzardi).
 */
export const summary = createRoute({
	method: "get",
	path: "/summary",
	tags: ["Dashboard"],
	summary: "Dashboard summary statistics",
	description: "High-level call center statistics for dashboard widgets.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: DashboardSummarySchema,
				},
			},
			description: "Dashboard summary",
		},
		...commonResponses,
	},
});

export const overview = createRoute({
	method: "get",
	path: "/overview",
	tags: ["Dashboard"],
	summary: "Dashboard ko'rsatkichlari (TZ 3.1)",
	description: [
		"Bitta so'rovda: qo'ng'iroq sonlari (inbound/outbound), javob berilgan/javobsiz nisbati,",
		"o'rtacha muloqot va kutish vaqti, operator statuslari, operator yuklamasi,",
		"AI kayfiyat taqsimoti va murojaat kategoriyalari.",
		"`previous` — teng uzunlikdagi oldingi oraliq (o'zgarish foizini UI hisoblaydi).",
		"Kutish vaqti `answeredAt - startedAt`; answeredAt yangi ustun bo'lgani uchun",
		"tarixiy qatorlarda NULL va o'rtachaga kirmaydi — namuna bo'lmasa null qaytadi.",
		"RBAC: manager faqat o'ziga biriktirilgan operator raqamlarini ko'radi,",
		"admin/supervisor — barchasini.",
	].join(" "),
	request: { query: PeriodQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: DashboardOverviewSchema } },
			description: "Dashboard ko'rsatkichlari",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const callVolume = createRoute({
	method: "get",
	path: "/call-volume",
	tags: ["Dashboard"],
	summary: "Qo'ng'iroq oqimi (vaqt qatori)",
	description: [
		"period=day — soatlik ustunlar (faqat o'tgan soatlar), week/month — kunlik ustunlar.",
		"Ustunlar Postgres'da guruhlanadi; qo'ng'iroq bo'lmagan ustun nol bilan qaytadi",
		"(grafik o'qi uzluksiz bo'lishi uchun).",
	].join(" "),
	request: { query: PeriodQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: DashboardCallVolumeSchema } },
			description: "Qo'ng'iroq oqimi",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const missedCalls = createRoute({
	method: "get",
	path: "/missed-calls",
	tags: ["Dashboard"],
	summary: "Javobsiz qo'ng'iroqlar ro'yxati",
	description: [
		"Haqiqiy qatorlar: status IN ('missed','abandoned'), yangilaridan boshlab,",
		"kontakt ismi bilan (kontakt yo'q bo'lsa null). Har qatorda haqiqiy status",
		"qaytadi — 'sabab' to'qib chiqarilmaydi.",
	].join(" "),
	request: { query: MissedCallsQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: DashboardMissedCallsSchema } },
			description: "Javobsiz qo'ng'iroqlar",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
