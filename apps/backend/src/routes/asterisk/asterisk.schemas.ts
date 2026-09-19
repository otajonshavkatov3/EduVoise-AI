import { z } from "@hono/zod-openapi";

import { uuidSchema } from "@/lib";

/**
 * Asterisk extension numbers in this deployment are numeric and short
 * (101..104 for operators, 900 for the AI agent). sip_extensions.extension is
 * varchar(10), so the upper bound is not cosmetic.
 */
export const extensionSchema = z
	.string()
	.regex(/^\d{2,10}$/)
	.openapi({ example: "101" });

const sipExtensionKindEnum = z.enum(["sip", "webrtc", "ai"]);
const operatorStatusEnum = z.enum(["online", "offline", "pause", "busy"]);

/** Live PJSIP state for one extension, as AMI reports it right now. */
export const AmiExtensionStateSchema = z
	.object({
		/** Asterisk device state: "Not in use", "In use", "Unavailable", "Ringing", ... */
		deviceState: z.string().nullable(),
		isRegistered: z.boolean(),
		contactCount: z.number().int(),
		/** Contact status: "Reachable", "Unreachable", "Unknown", "NonQualified", ... */
		registrationStatus: z.string().nullable(),
		userAgent: z.string().nullable(),
		roundtripUsec: z.number().int().nullable(),
	})
	.openapi("AsteriskAmiExtensionState");

export const AmiHealthSchema = z
	.object({
		connected: z.boolean(),
		/** e.g. "Asterisk Call Manager/9.0.0". Null before the first connection. */
		banner: z.string().nullable(),
		/** Why the live state could not be read. Never contains credentials. */
		error: z.string().nullable(),
	})
	.openapi("AsteriskAmiHealth");

export const AsteriskExtensionItemSchema = z
	.object({
		id: uuidSchema,
		extension: z.string(),
		displayName: z.string().nullable(),
		kind: sipExtensionKindEnum,
		isEnabled: z.boolean(),
		lastRegisteredAt: z.string().datetime().nullable(),
		lastKnownStatus: z.string().nullable(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		operator: z
			.object({
				id: uuidSchema,
				userId: uuidSchema,
				extension: z.string(),
				currentStatus: operatorStatusEnum,
			})
			.nullable(),
		/** Null when AMI could not be reached, so "offline" is never faked. */
		live: AmiExtensionStateSchema.nullable(),
	})
	.openapi("AsteriskExtensionItem");

export const ExtensionsOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(AsteriskExtensionItemSchema),
		total: z.number().int(),
		ami: AmiHealthSchema,
		/** PJSIP endpoints AMI knows about that sip_extensions has no row for. */
		unknownEndpoints: z.array(
			z.object({
				endpoint: z.string(),
				deviceState: z.string(),
			})
		),
	}),
});

export const SyncItemSchema = z
	.object({
		extension: z.string(),
		action: z.enum(["created", "updated", "unchanged"]),
		deviceState: z.string().nullable(),
		isRegistered: z.boolean(),
		operatorProfileId: uuidSchema.nullable(),
	})
	.openapi("AsteriskExtensionSyncItem");

export const SyncOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		endpointsFromAmi: z.number().int(),
		created: z.number().int(),
		updated: z.number().int(),
		unchanged: z.number().int(),
		/** Endpoint names AMI reported that are not usable as an extension number. */
		skipped: z.array(z.string()),
		/** Rows already in sip_extensions that AMI did not report. Left untouched. */
		notInAsterisk: z.array(z.string()),
		items: z.array(SyncItemSchema),
	}),
});

export const AsteriskStatusOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		/** ARI answered, i.e. Asterisk is really there. */
		reachable: z.boolean(),
		checkedAt: z.string().datetime(),
		ari: z.object({
			ok: z.boolean(),
			/** Credentials and query strings are stripped before this is returned. */
			baseUrl: z.string(),
			app: z.string(),
			version: z.string().nullable(),
			systemName: z.string().nullable(),
			startupTime: z.string().datetime().nullable(),
			uptimeSeconds: z.number().int().nullable(),
			error: z.string().nullable(),
		}),
		ami: z.object({
			ok: z.boolean(),
			host: z.string(),
			port: z.number().int(),
			banner: z.string().nullable(),
			error: z.string().nullable(),
		}),
		eventStream: z.object({
			/** The orchestrator owns the ARI WebSocket; it is up only while it runs. */
			running: z.boolean(),
			app: z.string(),
			url: z.string(),
		}),
		channels: z.object({
			active: z.number().int(),
			byState: z.array(z.object({ state: z.string(), count: z.number().int() })),
			error: z.string().nullable(),
		}),
		aiCalls: z.object({
			active: z.number().int(),
			orchestratorRunning: z.boolean(),
		}),
		backend: z.object({
			uptimeSeconds: z.number().int(),
		}),
	}),
});

export const OriginateBodySchema = z
	.object({
		/** Destination. A leading "+" is stripped: [click-to-call] matches _X. */
		toNumber: z
			.string()
			.regex(/^\+?\d{2,20}$/)
			.openapi({ example: "+998901234567" }),
		/** The operator's phone, rung first. */
		fromExtension: extensionSchema,
		/** Caller ID shown on the operator's phone. Defaults to the destination. */
		callerId: z.string().min(1).max(64).optional(),
		timeoutSeconds: z.number().int().min(5).max(120).optional().openapi({ example: 45 }),
	})
	.openapi("AsteriskOriginateBody");

export const OriginateOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		channelId: z.string(),
		channelName: z.string(),
		state: z.string(),
		endpoint: z.string(),
		context: z.string(),
		fromExtension: z.string(),
		toNumber: z.string(),
		/** What was actually put in the dialplan extension, i.e. digits only. */
		dialledNumber: z.string(),
		startedAt: z.string().datetime(),
	}),
});

export const TransferBodySchema = z
	.object({
		callId: uuidSchema,
		/** Preferred operator extension. Omit to let the router choose. */
		extension: extensionSchema.optional(),
		reason: z.string().min(1).max(500).optional(),
	})
	.openapi("AsteriskTransferBody");

export const TransferOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		callId: uuidSchema,
		connected: z.boolean(),
		extension: z.string().nullable(),
		transferId: uuidSchema.nullable(),
		/** "orchestrator" when the live call was handed over by the state machine. */
		source: z.enum(["orchestrator", "direct"]),
		strategy: z.enum(["ari-bridge", "ami-redirect", "queue", "none"]).nullable(),
		/** False when the dialplan now owns the caller, so the AI must stay quiet. */
		callerRetained: z.boolean(),
		alreadyInProgress: z.boolean(),
		failureReason: z.string().nullable(),
	}),
});

export const HangupBodySchema = z
	.object({
		callId: uuidSchema,
		reason: z.string().min(1).max(200).optional(),
	})
	.openapi("AsteriskHangupBody");

export const HangupOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		callId: uuidSchema,
		hungUp: z.boolean(),
		/** "orchestrator" tears the AI session down too; "ari" is the raw fallback. */
		source: z.enum(["orchestrator", "ari"]),
		channelId: z.string().nullable(),
		message: z.string(),
	}),
});

export type OriginateBody = z.infer<typeof OriginateBodySchema>;
export type TransferBody = z.infer<typeof TransferBodySchema>;
export type HangupBody = z.infer<typeof HangupBodySchema>;
export type AsteriskExtensionItem = z.infer<typeof AsteriskExtensionItemSchema>;
