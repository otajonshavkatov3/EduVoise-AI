import { z } from "zod/v4";

/**
 * The tenant's own webhook URL, as a path parameter.
 *
 * These webhooks are unauthenticated by necessity - a PBX cannot send a bearer
 * token - and the payload names no tenant, so before this the endpoint could only
 * refuse once a second customer existed. The token both identifies the tenant and
 * authenticates the caller, and a PBX only ever needs a URL.
 */
export const WebhookTenantParamsSchema = z.object({
	webhookToken: z
		.string()
		.min(32)
		.max(64)
		.regex(/^[a-f0-9]+$/, { message: "Webhook tokeni noto'g'ri" })
		.openapi({
			param: { name: "webhookToken", in: "path", required: true },
		}),
});

export const FreePBXCallStartBodySchema = z.object({
	direction: z.enum(["inbound", "outbound"]),
	callerNumber: z.string().min(1).max(20),
	calleeExtension: z.string().max(10).optional(),
	contactId: z.string().uuid().optional(),
	operatorId: z.string().uuid().optional(),
	ticketId: z.string().uuid().optional(),
});

export type FreePBXCallStartBody = z.infer<typeof FreePBXCallStartBodySchema>;

export const FreePBXCallEndBodySchema = z.object({
	callId: z.string().uuid(),
	duration: z.number().int().min(0),
	recordingPath: z.string().max(500).optional(),
	status: z.enum(["answered", "missed", "abandoned", "completed"]),
});

export type FreePBXCallEndBody = z.infer<typeof FreePBXCallEndBodySchema>;
