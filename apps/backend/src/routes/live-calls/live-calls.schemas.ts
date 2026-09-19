import { z } from "@hono/zod-openapi";

import { uuidSchema } from "@/lib";

const liveCallStatusEnum = z.enum([
	"starting",
	"live",
	"transferring",
	"transferred",
	"ending",
	"ended",
]);
const transferPhaseEnum = z.enum(["none", "requested", "connected", "failed"]);
const callDirectionEnum = z.enum(["inbound", "outbound"]);
const callStatusEnum = z.enum(["ringing", "answered", "missed", "abandoned", "completed"]);
const aiSessionStatusEnum = z.enum([
	"initializing",
	"active",
	"transferring",
	"completed",
	"failed",
]);
const transcriptRoleEnum = z.enum(["caller", "agent", "system"]);

/** contacts.address jsonb - { tuman, kocha, uy }. */
const AddressSchema = z.object({
	tuman: z.string(),
	kocha: z.string(),
	uy: z.string(),
});

export const LiveCallContactSchema = z
	.object({
		id: uuidSchema,
		firstName: z.string().nullable(),
		lastName: z.string().nullable(),
		/** Joined name, or null - same convention as the legacy webhook payload. */
		contactName: z.string().nullable(),
		address: AddressSchema.nullable(),
	})
	.openapi("LiveCallContact");

export const LiveCallAiSessionSchema = z
	.object({
		id: uuidSchema,
		status: aiSessionStatusEnum,
		provider: z.string(),
		model: z.string().nullable(),
		voice: z.string().nullable(),
		language: z.string().nullable(),
		interruptions: z.number().int(),
		inputAudioMs: z.number().int(),
		outputAudioMs: z.number().int(),
		errorMessage: z.string().nullable(),
		startedAt: z.string().datetime(),
		endedAt: z.string().datetime().nullable(),
	})
	.openapi("LiveCallAiSession");

/**
 * One row of the live-call board. Not registered as a named component because
 * the detail response extends it.
 */
export const LiveCallItemSchema = z.object({
	callId: uuidSchema,
	channelId: z.string(),
	callerNumber: z.string(),
	direction: callDirectionEnum,
	/** Where the call is in the AI flow, straight from the orchestrator. */
	status: liveCallStatusEnum,
	/** calls.status in the database, which lags the live state. */
	callStatus: callStatusEnum.nullable(),
	provider: z.string().nullable(),
	aiSessionId: uuidSchema.nullable(),
	aiSession: LiveCallAiSessionSchema.nullable(),
	contact: LiveCallContactSchema.nullable(),
	isReturningCaller: z.boolean(),
	previousCallCount: z.number().int(),
	ticketId: uuidSchema.nullable(),
	/** operator_profiles.id, set once a transfer connects. */
	operatorId: uuidSchema.nullable(),
	transferExtension: z.string().nullable(),
	transferStatus: transferPhaseEnum,
	startedAt: z.string().datetime(),
	durationSeconds: z.number().int(),
});

export const LiveTranscriptLineSchema = z
	.object({
		id: uuidSchema,
		role: transcriptRoleEnum,
		content: z.string(),
		startMs: z.number().int().nullable(),
		endMs: z.number().int().nullable(),
		isFinal: z.boolean(),
		confidence: z.number().int().nullable(),
		createdAt: z.string().datetime(),
	})
	.openapi("LiveCallTranscriptLine");

export const LiveCallsOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(LiveCallItemSchema),
		total: z.number().int(),
		orchestratorRunning: z.boolean(),
		/** True when only the caller's own calls are included. */
		scopedToOperator: z.boolean(),
	}),
});

export const LiveCallOneOutSchema = z.object({
	success: z.literal(true),
	data: LiveCallItemSchema.extend({
		transcript: z.array(LiveTranscriptLineSchema),
		/** Every stored line for this call, not just the returned window. */
		transcriptCount: z.number().int(),
	}),
});

export const OneQuerySchema = z.object({
	transcriptLimit: z
		.string()
		.optional()
		.default("50")
		.transform(Number)
		.pipe(z.number().int().min(1).max(200))
		.openapi({
			param: { name: "transcriptLimit", in: "query" },
			example: "50",
		}),
});

export type LiveCallItem = z.infer<typeof LiveCallItemSchema>;
export type LiveTranscriptLine = z.infer<typeof LiveTranscriptLineSchema>;
