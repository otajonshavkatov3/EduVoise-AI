import { getServerEnv } from "@shared/env";
import { asTenantId, type TenantId, type UserRoleType } from "@shared/types";
import * as jose from "jose";

const env = getServerEnv();

const accessSecret = new TextEncoder().encode(env.JWT_SECRET);

/**
 * The access token's schema version, and the answer to "what happens to a token
 * minted before tenancy".
 *
 * Version 1 tokens carried { sub, role } and nothing else. There is no safe way to
 * interpret one now: the only ways to give it a tenant are to look the user up (a
 * database read on every request, to resurrect a credential that predates the
 * security model) or to pick a default tenant - and "the default tenant" is
 * literally the cross-tenant read this phase exists to prevent. So they are
 * REFUSED: verifyAccessToken() requires ver === 2 and a tenant claim.
 *
 * Refusing costs nothing operationally. Refresh tokens are opaque random strings
 * kept in Redis and are not affected, so a client holding a v1 access token calls
 * /auth/refresh once - which every client already does on a 401 - and gets a
 * tenant-aware token back. Nobody is logged out; nobody keeps a token that is
 * valid for any tenant.
 */
export const ACCESS_TOKEN_VERSION = 2;

/**
 * Who a vendor really is while acting inside a customer's account.
 *
 * Present ONLY on an impersonation token. Its presence is what distinguishes "the
 * platform owner, currently inside customer X" from "customer X's own supervisor",
 * and it is what the audit trail records.
 */
export interface AccessTokenActor {
	/** The vendor user id. */
	sub: string;
	/** The vendor's own tenant. */
	tid: TenantId;
}

export interface AccessTokenPayload {
	sub: string; // userId
	role: UserRoleType;
	/** The tenant this token acts inside. EVERY query in the request is scoped to it. */
	tid: TenantId;
	ver: number;
	act?: AccessTokenActor;
}

export interface MintAccessTokenInput {
	userId: string;
	role: UserRoleType;
	/** The tenant the token acts inside - the user's own, or the one a vendor entered. */
	tenantId: TenantId;
	/** Set only when minting an impersonation token. */
	actor?: { userId: string; tenantId: TenantId };
	/** Override the default lifetime. Impersonation tokens use a short one. */
	expiresIn?: string;
}

function parseDuration(duration: string): number {
	const match = duration.match(/^(\d+)([smhd])$/);
	if (!match) {
		throw new Error(`Invalid duration format: ${duration}`);
	}

	const value = Number.parseInt(match[1], 10);
	const unit = match[2];

	switch (unit) {
		case "s":
			return value;
		case "m":
			return value * 60;
		case "h":
			return value * 60 * 60;
		case "d":
			return value * 60 * 60 * 24;
		default:
			throw new Error(`Unknown time unit: ${unit}`);
	}
}

/**
 * Mint an access token.
 *
 * Takes a named object rather than positional arguments deliberately: userId,
 * tenantId and the actor's userId are all uuid strings, and a positional signature
 * lets any two of them be swapped without a word from the compiler. With names,
 * `generateAccessToken(user.id, user.role)` - every pre-tenancy call site - fails
 * to compile instead of minting a token with no tenant.
 */
export async function generateAccessToken(input: MintAccessTokenInput): Promise<string> {
	const expiresIn = input.expiresIn ?? env.JWT_EXPIRES_IN;

	const claims: Record<string, unknown> = {
		role: input.role,
		tid: input.tenantId,
		ver: ACCESS_TOKEN_VERSION,
	};

	if (input.actor) {
		claims.act = { sub: input.actor.userId, tid: input.actor.tenantId };
	}

	return await new jose.SignJWT(claims)
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(input.userId)
		.setIssuedAt()
		.setExpirationTime(expiresIn)
		.sign(accessSecret);
}

function readActor(raw: unknown): AccessTokenActor | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const candidate = raw as Record<string, unknown>;

	if (typeof candidate.sub !== "string" || typeof candidate.tid !== "string") {
		// A malformed actor claim must not silently degrade to "not impersonating":
		// that would be an all-access token with no vendor trace in the audit log.
		throw new Error("Invalid token payload");
	}

	return { sub: candidate.sub, tid: asTenantId(candidate.tid) };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
	const { payload } = await jose.jwtVerify(token, accessSecret);

	if (!(payload.sub && payload.role)) {
		throw new Error("Invalid token payload");
	}

	// A token with no tenant, or from an older schema, is refused rather than
	// interpreted. See ACCESS_TOKEN_VERSION.
	if (payload.ver !== ACCESS_TOKEN_VERSION || typeof payload.tid !== "string") {
		throw new Error("Invalid token payload");
	}

	return {
		sub: payload.sub,
		role: payload.role as UserRoleType,
		tid: asTenantId(payload.tid),
		ver: payload.ver,
		act: readActor(payload.act),
	};
}

export function generateRefreshToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Buffer.from(bytes).toString("base64url");
}

export function getRefreshTokenExpirySeconds(): number {
	return parseDuration(env.REFRESH_TOKEN_EXPIRES_IN);
}
