import { z } from "@hono/zod-openapi";

/**
 * The tenant shape the vendor console sees.
 *
 * Mirrors PublicTenant in lib/tenancy/public.ts, which is the type the handler
 * actually returns - the secrets (the AI key we assign them, their trunk password)
 * are absent from BOTH, and a test asserts the type cannot regain them.
 */
export const TenantItemSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	slug: z.string(),
	status: z.enum(["trial", "active", "suspended", "closed"]),
	isVendor: z.boolean(),
	contactPerson: z.string().nullable(),
	contactPhone: z.string().nullable(),
	contactEmail: z.string().nullable(),
	timezone: z.string(),
	aiApiKeyProvider: z.string().nullable(),
	/** Whether a per-tenant AI key is set. Never the key itself. */
	hasAiApiKey: z.boolean(),
	sipTrunkHost: z.string().nullable(),
	sipTrunkPort: z.number().nullable(),
	sipTrunkUsername: z.string().nullable(),
	sipTrunkFromDomain: z.string().nullable(),
	sipTrunkRegister: z.boolean(),
	sipOutboundCallerId: z.string().nullable(),
	/** Whether a trunk password is stored. Never the password. */
	hasSipTrunkPassword: z.boolean(),
	notes: z.string().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(TenantItemSchema),
	}),
});

export const EnterBodySchema = z.object({
	/**
	 * Why the vendor is entering this account, in one line.
	 *
	 * Optional, and recorded in the audit row when given. Not required, because a
	 * required field on a support path gets filled with "asdf" - the row is written
	 * either way, and that is the part that matters.
	 */
	reason: z.string().max(500).optional(),
});

export const EnterOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		/**
		 * A short-lived access token scoped to the customer's tenant, carrying the
		 * vendor as the actor. Send it as the Bearer token to act inside that account.
		 */
		accessToken: z.string(),
		expiresIn: z.string(),
		tenant: TenantItemSchema,
	}),
});

export type EnterBody = z.infer<typeof EnterBodySchema>;
