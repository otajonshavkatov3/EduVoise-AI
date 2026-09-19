import { getServerEnv } from "@shared/env";

const env = getServerEnv();

const redis = new Bun.RedisClient(env.REDIS_URL);

const REFRESH_TOKEN_PREFIX = "refresh_token:";

/**
 * Reverse index: token -> userId.
 *
 * Without it, refreshing a token means loading every active user and asking Redis
 * once per user whether the token belongs to them. The TZ targets 100+ concurrent
 * operators, so that is up to 100 round-trips for a single refresh, on the hot
 * path of every 15-minute access-token renewal. This makes it one GET.
 */
const REFRESH_OWNER_PREFIX = "refresh_owner:";

export async function storeRefreshToken(
	userId: string,
	token: string,
	expiresInSeconds: number
): Promise<void> {
	const key = `${REFRESH_TOKEN_PREFIX}${userId}:${token}`;
	await redis.set(key, "1", "EX", expiresInSeconds);
	// Same TTL, so the index can never outlive the token it points at.
	await redis.set(`${REFRESH_OWNER_PREFIX}${token}`, userId, "EX", expiresInSeconds);
}

/**
 * Owner of a refresh token, or null when it is unknown/expired.
 *
 * Returns null for tokens issued before the reverse index existed; the caller
 * falls back to the old scan in that case, so no session is invalidated by the
 * upgrade.
 */
export async function findRefreshTokenOwner(token: string): Promise<string | null> {
	return await redis.get(`${REFRESH_OWNER_PREFIX}${token}`);
}

export async function isRefreshTokenValid(userId: string, token: string): Promise<boolean> {
	const key = `${REFRESH_TOKEN_PREFIX}${userId}:${token}`;
	const result = await redis.get(key);
	return result !== null;
}

export async function deleteRefreshToken(userId: string, token: string): Promise<void> {
	const key = `${REFRESH_TOKEN_PREFIX}${userId}:${token}`;
	await redis.del(key);
	await redis.del(`${REFRESH_OWNER_PREFIX}${token}`);
}

/**
 * Revokes every session for a user. Used on password change, so a stolen token
 * stops working the moment the password is rotated.
 */
export async function deleteAllUserTokens(userId: string): Promise<void> {
	const prefix = `${REFRESH_TOKEN_PREFIX}${userId}:`;
	const keys = await redis.keys(`${prefix}*`);

	if (keys.length === 0) {
		return;
	}

	// The token is the tail of "refresh_token:<userId>:<token>", so the reverse
	// index entries can be cleaned up without a second scan. Leaving them behind
	// would let a revoked token still resolve to an owner.
	const ownerKeys = keys
		.map((key) => key.slice(prefix.length))
		.filter((token) => token.length > 0)
		.map((token) => `${REFRESH_OWNER_PREFIX}${token}`);

	await redis.del(...keys, ...ownerKeys);
}

export { redis };
