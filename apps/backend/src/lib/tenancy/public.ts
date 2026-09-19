/**
 * The only shape of a tenant the HTTP layer is allowed to return.
 *
 * A tenant row holds two secrets - the AI key we assign them and their SIP trunk
 * password - and neither may leave the process. Masking at each endpoint is how a
 * secret eventually ships in a response: somebody adds a field, or returns the row
 * from a new route, and nothing complains. So the direction is inverted here. The
 * row goes in, a type with no secret fields comes out, and a test asserts that the
 * public type's key list does not intersect the secret column list. A field added
 * to the tenants table is absent from responses until somebody adds it HERE, on
 * purpose.
 *
 * The presence of a key is still useful to the vendor console ("has this customer
 * got their own key yet?"), so booleans are exposed instead of values.
 */
import type { TenantId } from "@shared/types";

import type { TenantRecord, TenantStatus } from "@/db/schema";

/**
 * Columns that must never reach a response. Named, so the test that enforces this
 * has something to check against rather than trusting the mapper below.
 */
export const TENANT_SECRET_COLUMNS = ["aiApiKey", "sipTrunkPassword", "webhookToken"] as const;

export type TenantSecretColumn = (typeof TENANT_SECRET_COLUMNS)[number];

export interface PublicTenant {
	id: TenantId;
	name: string;
	slug: string;
	status: TenantStatus;
	isVendor: boolean;
	contactPerson: string | null;
	contactPhone: string | null;
	contactEmail: string | null;
	timezone: string;
	/** Which provider a per-tenant key is set for, if any. Never the key. */
	aiApiKeyProvider: string | null;
	/** Whether the vendor has assigned this tenant its own AI key. Never the key. */
	hasAiApiKey: boolean;
	sipTrunkHost: string | null;
	sipTrunkPort: number | null;
	sipTrunkUsername: string | null;
	sipTrunkFromDomain: string | null;
	sipTrunkRegister: boolean;
	sipOutboundCallerId: string | null;
	/** Whether a trunk password is stored. Never the password. */
	hasSipTrunkPassword: boolean;
	notes: string | null;
	createdAt: string;
	updatedAt: string;
}

export function toPublicTenant(row: TenantRecord): PublicTenant {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		status: row.status,
		isVendor: row.isVendor,
		contactPerson: row.contactPerson,
		contactPhone: row.contactPhone,
		contactEmail: row.contactEmail,
		timezone: row.timezone,
		aiApiKeyProvider: row.aiApiKeyProvider,
		hasAiApiKey: (row.aiApiKey ?? "").trim().length > 0,
		sipTrunkHost: row.sipTrunkHost,
		sipTrunkPort: row.sipTrunkPort,
		sipTrunkUsername: row.sipTrunkUsername,
		sipTrunkFromDomain: row.sipTrunkFromDomain,
		sipTrunkRegister: row.sipTrunkRegister,
		sipOutboundCallerId: row.sipOutboundCallerId,
		hasSipTrunkPassword: (row.sipTrunkPassword ?? "").trim().length > 0,
		notes: row.notes,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
