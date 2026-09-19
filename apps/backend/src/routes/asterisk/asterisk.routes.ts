import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";

import { commonResponses, ErrorResponseSchema } from "@/lib";

import {
	AsteriskStatusOutSchema,
	ExtensionsOutSchema,
	HangupBodySchema,
	HangupOutSchema,
	OriginateBodySchema,
	OriginateOutSchema,
	SyncOutSchema,
	TransferBodySchema,
	TransferOutSchema,
} from "./asterisk.schemas";

export const listExtensions = createRoute({
	method: "get",
	path: "/extensions",
	tags: ["Asterisk"],
	summary: "List SIP extensions with live AMI state",
	description:
		"sip_extensions jadvali + AMI'dan real vaqt holati (PJSIPShowEndpoints / PJSIPShowContacts). " +
		"AMI ishlamasa `live` null bo'ladi va `ami.error` sababni ko'rsatadi — ro'yxat baribir qaytadi.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: ExtensionsOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const syncExtensions = createRoute({
	method: "post",
	path: "/extensions/sync",
	tags: ["Asterisk"],
	summary: "Reconcile sip_extensions from AMI (Supervisor)",
	description:
		"AMI'dagi PJSIP endpointlar bo'yicha sip_extensions'ni yangilaydi: yo'q qatorlar yaratiladi, " +
		"holat (device state, registratsiya vaqti) va bo'sh operator bog'lanishi to'ldiriladi. " +
		"Hech qanday qator o'chirilmaydi yoki o'chirib qo'yilmaydi — AMI ko'rmagan extensionlar " +
		"`notInAsterisk` ro'yxatida qaytadi.",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: SyncOutSchema } },
			description: "",
		},
		[HttpStatusCodes.UNPROCESSABLE_ENTITY]: {
			content: { "application/json": { schema: ErrorResponseSchema } },
			description: "AMI is unreachable, so there is nothing to reconcile against",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const status = createRoute({
	method: "get",
	path: "/status",
	tags: ["Asterisk"],
	summary: "Asterisk health (ARI, AMI, event stream, channels)",
	description:
		"ARI /asterisk/info, AMI Ping, ARI event stream holati, aktiv kanallar soni va Asterisk uptime. " +
		"Parollar hech qachon qaytarilmaydi (URL'dan credential va query olib tashlanadi).",
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: AsteriskStatusOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const originate = createRoute({
	method: "post",
	path: "/originate",
	tags: ["Asterisk"],
	summary: "Click-to-call (Admin/Supervisor)",
	description:
		"PJSIP/<fromExtension> kanalini [click-to-call] kontekstiga originate qiladi: avval operator " +
		"telefoni jiringlaydi, keyin dialplan raqamni teradi. Audit log yoziladi.",
	request: { body: jsonContentRequired(OriginateBodySchema, "body") },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: OriginateOutSchema } },
			description: "",
		},
		[HttpStatusCodes.UNPROCESSABLE_ENTITY]: {
			content: { "application/json": { schema: ErrorResponseSchema } },
			description: "Asterisk refused the originate, or the extension is unknown",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const transfer = createRoute({
	method: "post",
	path: "/transfer",
	tags: ["Asterisk"],
	summary: "Transfer a live call to a human",
	description:
		"Jonli qo'ng'iroqni operatorga uzatadi. Orchestrator kuzatayotgan qo'ng'iroq bo'lsa u orqali, " +
		"aks holda ai_sessions.channel_id bo'yicha to'g'ridan-to'g'ri transferToHuman ishlatiladi. " +
		"Audit log yoziladi.",
	request: { body: jsonContentRequired(TransferBodySchema, "body") },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: TransferOutSchema } },
			description: "",
		},
		[HttpStatusCodes.UNPROCESSABLE_ENTITY]: {
			content: { "application/json": { schema: ErrorResponseSchema } },
			description: "The call has no live channel to transfer",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});

export const hangup = createRoute({
	method: "post",
	path: "/hangup",
	tags: ["Asterisk"],
	summary: "Hang up a live call (Admin/Supervisor)",
	description:
		"Jonli qo'ng'iroqni tugatadi. Orchestrator bilsa AI sessiyasi ham to'g'ri yopiladi, " +
		"aks holda ARI hangup ishlatiladi. Audit log yoziladi.",
	request: { body: jsonContentRequired(HangupBodySchema, "body") },
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: HangupOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
