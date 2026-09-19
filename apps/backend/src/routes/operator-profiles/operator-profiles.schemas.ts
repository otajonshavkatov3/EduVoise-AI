import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema } from "@/lib";

export const statusEnum = z.enum(["online", "offline", "pause", "busy"]);

export const CreateBodySchema = z.object({
	userId: z.string().uuid(),
	extension: z.string().min(1).max(10),
});

export const UpdateStatusSchema = z.object({
	status: statusEnum,
});

export const UpdateBodySchema = z.object({
	extension: z.string().min(1).max(10).optional(),
	status: statusEnum.optional(),
});

export const ProfileItemSchema = z.object({
	id: z.string().uuid(),
	userId: z.string().uuid(),
	extension: z.string(),
	currentStatus: statusEnum,
	lastStatusChange: z.string().datetime().nullable(),
	isDeleted: z.boolean(),
	createdAt: z.string().datetime(),
	user: z.object({ id: z.string().uuid(), phone: z.string(), role: z.string() }).optional(),
});

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(ProfileItemSchema),
		meta: PaginationMetaSchema,
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: ProfileItemSchema,
});

export const RemoveOutSchema = z.object({
	success: z.literal(true),
	data: z.object({ message: z.string() }),
});

/**
 * The logged-in operator's OWN browser-softphone SIP identity.
 *
 * Handed out only to the authenticated operator it belongs to, so each operator
 * registers the dashboard softphone as their own web endpoint (202/203/...) instead
 * of one shared extension baked into the bundle - which is what lets an AI transfer
 * ring the right operator's browser and lets two operators be online at once.
 */
export const SipIdentityOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		/** The operator's desk extension, e.g. "102". */
		deskExtension: z.string(),
		/** The paired browser-softphone extension, e.g. "202". */
		webExtension: z.string(),
		/** SIP auth + URI user the browser registers as, e.g. "avilab-202". */
		sipUsername: z.string(),
		/** SIP auth password for that endpoint. */
		sipPassword: z.string(),
		/** Where the browser opens its SIP-over-WebSocket connection. */
		wsUrl: z.string(),
		/** The SIP domain/realm for the registration URI. */
		realm: z.string(),
	}),
});

export const ListQuerySchema = z
	.object({
		includeDeleted: z.enum(["true", "false"]).optional().default("false"),
	})
	.merge(PaginationQuerySchema);

export type CreateBody = z.infer<typeof CreateBodySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
export type ProfileItem = z.infer<typeof ProfileItemSchema>;
