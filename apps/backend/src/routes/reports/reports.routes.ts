import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { commonResponses } from "@/lib";

import {
	CallsExportQuerySchema,
	CallsQuerySchema,
	CallsReportOutSchema,
	MAX_EXPORT_ROWS,
	MAX_RANGE_DAYS,
	OperatorsExportQuerySchema,
	OperatorsQuerySchema,
	OperatorsReportOutSchema,
	TicketsExportQuerySchema,
	TicketsQuerySchema,
	TicketsReportOutSchema,
} from "./reports.schemas";

const RBAC_NOTE = "Faqat supervisor va admin (TZ 3.9 — hisobotlarni eksport qilish).";
const RANGE_NOTE = `from va to majburiy, oraliq eng ko'pi bilan ${MAX_RANGE_DAYS} kun.`;
const EXPORT_NOTE = `Qator soni ${MAX_EXPORT_ROWS} dan oshsa fayl generatsiya qilinmaydi (422) — oraliqni toraytirish kerak. Har bir eksport auditLogs'ga yoziladi.`;

/** Eksport javobi — haqiqiy fayl, JSON emas. */
const fileResponses = {
	content: {
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { schema: z.string() },
		"text/csv": { schema: z.string() },
	},
	description: "Excel (xlsx) yoki CSV fayl (Content-Disposition: attachment)",
};

export const callsReport = createRoute({
	method: "get",
	path: "/calls",
	tags: ["Reports"],
	summary: "Calls report (paginated preview + totals)",
	description: `Qo'ng'iroqlar hisoboti: sahifalangan qatorlar va butun oraliq bo'yicha jamlanma. ${RANGE_NOTE} ${RBAC_NOTE}`,
	request: { query: CallsQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: CallsReportOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const callsExport = createRoute({
	method: "get",
	path: "/calls/export",
	tags: ["Reports"],
	summary: "Export calls report (xlsx or CSV)",
	description: `Preview bilan bir xil filtrlar. ${EXPORT_NOTE} ${RBAC_NOTE}`,
	request: { query: CallsExportQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: fileResponses,
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const ticketsReport = createRoute({
	method: "get",
	path: "/tickets",
	tags: ["Reports"],
	summary: "Tickets report (paginated preview + totals)",
	description: `Murojaatlar hisoboti. operatorId — murojaatni yaratgan operator profili. ${RANGE_NOTE} ${RBAC_NOTE}`,
	request: { query: TicketsQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: TicketsReportOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const ticketsExport = createRoute({
	method: "get",
	path: "/tickets/export",
	tags: ["Reports"],
	summary: "Export tickets report (xlsx or CSV)",
	description: `Preview bilan bir xil filtrlar. ${EXPORT_NOTE} ${RBAC_NOTE}`,
	request: { query: TicketsExportQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: fileResponses,
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const operatorsReport = createRoute({
	method: "get",
	path: "/operators",
	tags: ["Reports"],
	summary: "Operators performance report (paginated preview + totals)",
	description: `Operatorlar kesimidagi ko'rsatkichlar. Oraliqda faoliyati bo'lgan o'chirilgan profillar ham ko'rsatiladi (isDeleted = true). ${RANGE_NOTE} ${RBAC_NOTE}`,
	request: { query: OperatorsQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: OperatorsReportOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const operatorsExport = createRoute({
	method: "get",
	path: "/operators/export",
	tags: ["Reports"],
	summary: "Export operators report (xlsx or CSV)",
	description: `Preview bilan bir xil filtrlar. ${EXPORT_NOTE} ${RBAC_NOTE}`,
	request: { query: OperatorsExportQuerySchema },
	responses: {
		[HttpStatusCodes.OK]: fileResponses,
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
