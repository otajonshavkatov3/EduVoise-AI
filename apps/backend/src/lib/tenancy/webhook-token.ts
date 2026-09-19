import { randomBytes } from "node:crypto";

/**
 * The secret that lives in a tenant's own webhook URL.
 *
 * These webhooks cannot carry a bearer token - a PBX has nowhere to put one - and
 * their payload names no tenant, so the URL itself has to do both jobs. That makes
 * this a credential, not an identifier: it is generated from a CSPRNG, it is long
 * enough that guessing is hopeless, and it is rotatable, because a credential that
 * cannot be rotated is one that can only ever be leaked.
 *
 * 32 bytes as lowercase hex is 64 characters, which is the column width.
 */
const TOKEN_BYTES = 32;

export function generateWebhookToken(): string {
	return randomBytes(TOKEN_BYTES).toString("hex");
}
