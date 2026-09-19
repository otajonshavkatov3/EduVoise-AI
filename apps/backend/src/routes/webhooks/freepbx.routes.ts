import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContentRequired } from "stoker/openapi/helpers";
import { z } from "zod/v4";

import { commonResponses } from "@/lib";

import {
	FreePBXCallEndBodySchema,
	FreePBXCallStartBodySchema,
	WebhookTenantParamsSchema,
} from "./freepbx.schemas";

const CallStartContactSchema = z
	.object({
		id: z.string().uuid(),
		firstName: z.string().nullable(),
		lastName: z.string().nullable(),
		address: z
			.object({
				tuman: z.string().optional(),
				kocha: z.string().optional(),
				uy: z.string().optional(),
			})
			.nullable(),
	})
	.openapi("CallStartContact");

const CallStartResponseSchema = z
	.object({
		id: z.string().uuid(),
		success: z.literal(true),
		createdAt: z.string().datetime(),
		startedAt: z.string().datetime(),
		contact: CallStartContactSchema.nullable(),
	})
	.openapi("CallStartResponse");

export const callStart = createRoute({
	method: "post",
	path: "/{webhookToken}/call-start",
	tags: ["Webhooks"],
	summary: "FreePBX Call Start",
	description:
		"FreePBX dan Call Start webhook. Qo'ng'iroqni calls jadvaliga yozadi (direction: inbound/outbound).",
	request: {
		params: WebhookTenantParamsSchema,
		body: jsonContentRequired(FreePBXCallStartBodySchema, "Call Start payload"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: CallStartResponseSchema,
				},
			},
			description: "Qo'ng'iroq yozildi",
		},
		...commonResponses,
	},
});

const CallEndResponseSchema = z
	.object({
		success: z.literal(true),
		id: z.string().uuid(),
		status: z.enum(["answered", "missed", "abandoned", "completed"]),
		endedAt: z.string().datetime().nullable(),
	})
	.openapi("CallEndResponse");

export const callEnd = createRoute({
	method: "post",
	path: "/{webhookToken}/call-end",
	tags: ["Webhooks"],
	summary: "FreePBX Call End & Recording",
	description:
		"Call End event: duration saqlash, recording_path va call_status yangilash (Call Start javobidagi id — callId orqali qaydni topamiz).",
	request: {
		params: WebhookTenantParamsSchema,
		body: jsonContentRequired(FreePBXCallEndBodySchema, "Call End payload"),
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: CallEndResponseSchema,
				},
			},
			description: "Qo'ng'iroq yangilandi",
		},
		...commonResponses,
	},
});
