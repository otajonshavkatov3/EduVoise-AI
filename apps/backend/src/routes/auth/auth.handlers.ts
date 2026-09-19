/**
 * AUTHENTICATION, WHICH IS WHERE A TENANT MISTAKE IS WORST.
 *
 * Three rules hold this file together:
 *
 *  1. A LOGIN IDENTITY IS PLATFORM-WIDE. users.phone carries a unique index across
 *     all tenants (users_phone_unique) because the login form has one phone and one
 *     password and no tenant field. So the phone lookups in register/login are
 *     deliberately NOT scoped - they ask "which single account is this", and the
 *     answer is what decides the tenant. A tenant-scoped lookup here would need the
 *     caller to say which tenant they meant, and a tenant a client can state is a
 *     tenant a client can change.
 *  2. THE TENANT COMES FROM THE ROW, NEVER FROM THE REQUEST. login and refresh mint
 *     tokens with `user.tenantId` read from the authenticated row.
 *  3. A NON-OPERATIONAL TENANT GETS NO CREDENTIALS. Suspended and closed customers
 *     are refused at login and at refresh, not only per request afterwards - phase
 *     two suspends an account when the minutes run out, and handing out a fresh
 *     30-minute token to an account we have just cut off is not a boundary.
 */
import type { UserRoleType } from "@shared/types";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/lib/audit";
import {
	generateAccessToken,
	generateRefreshToken,
	getRefreshTokenExpirySeconds,
	hashPassword,
	requireRoles,
	verifyPassword,
} from "@/lib/auth";
import {
	alreadyExists,
	databaseError,
	invalidCredentials,
	invalidInput,
	notFound,
} from "@/lib/errors";
import {
	deleteAllUserTokens,
	deleteRefreshToken,
	findRefreshTokenOwner,
	isRefreshTokenValid,
	storeRefreshToken,
} from "@/lib/redis";
import { currentTenantId, getTenantById, isTenantOperational, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";

import type { changePassword, login, logout, me, refresh, register } from "./auth.routes";

type UserRow = typeof users.$inferSelect;

/**
 * Who may create a staff account. The same two roles that may edit or delete one -
 * see routes/users, where SUPERVISOR_ONLY means exactly this pair.
 */
const STAFF_MANAGER_ROLES: UserRoleType[] = ["supervisor", "admin"];

/**
 * Refuse to mint credentials for a tenant that may not work.
 *
 * The auth middleware asks the same question on every authenticated request, so this
 * is not the enforcement - it is the difference between "you cannot use this account"
 * at the door and a login that succeeds followed by every page failing. Both the
 * message and the 401 are the ones a wrong password gets when the tenant is gone
 * entirely: an attacker probing phone numbers learns nothing about which accounts
 * exist.
 */
async function requireOperationalTenantForCredentials(user: UserRow): Promise<void> {
	const tenant = await getTenantById(user.tenantId);

	if (!tenant) {
		throw invalidCredentials("Telefon raqami yoki parol noto'g'ri");
	}

	if (!isTenantOperational(tenant.status)) {
		throw invalidCredentials(
			tenant.status === "suspended"
				? "Hisob to'xtatilgan. Iltimos, xizmat ko'rsatuvchi bilan bog'laning."
				: "Hisob yopilgan"
		);
	}
}

export const registerHandler: AppRouteHandler<typeof register> = async (c) => {
	// This endpoint creates a STAFF ACCOUNT inside the caller's tenant, so it is gated
	// like the rest of staff management (PATCH and DELETE /users are supervisor+admin).
	// Without a gate any authenticated manager could mint accounts in their own
	// company - and, once the vendor console can suspend a customer, mint themselves a
	// fresh one.
	requireRoles(c, STAFF_MANAGER_ROLES);

	const { phone, password } = c.req.valid("json");

	// Phone is unique platform-wide (see the users schema), so this lookup is
	// deliberately NOT tenant-scoped: it answers "is this login taken anywhere",
	// which is what makes a phone identify exactly one account.
	const existing = await db.query.users.findFirst({
		where: eq(users.phone, phone),
	});

	if (existing) {
		throw alreadyExists("Foydalanuvchi", "telefon raqami");
	}

	const passwordHash = await hashPassword(password);

	/**
	 * THE NEW ACCOUNT JOINS THE CALLER'S TENANT.
	 *
	 * This route is mounted BEHIND authMiddleware (see routes/auth/index.ts) - it is
	 * not open registration, it is how a customer's supervisor creates staff, and the
	 * frontend's "add user" dialog calls exactly this followed by PATCH /users/{id}
	 * to set the role. So the tenant is the caller's, taken from the token.
	 *
	 * It previously used getSoleTenantId(), the transitional "there is only one
	 * customer" seam. That was wrong in both directions: it would have thrown the
	 * moment a second customer existed - leaving every customer unable to create a
	 * single operator, the one thing they paid for - and until then it would have
	 * stamped "tenant one" on a user created by anybody else.
	 */
	const tenantId = currentTenantId(c);

	const [user] = await db
		.insert(users)
		.values({
			tenantId,
			phone,
			passwordHash,
			role: "manager",
			isActive: true,
		})
		.returning({
			id: users.id,
			phone: users.phone,
			role: users.role,
			isActive: users.isActive,
			createdAt: users.createdAt,
		});

	if (!user) {
		throw databaseError("Foydalanuvchi yozuvi yaratilmadi");
	}

	const accessToken = await generateAccessToken({
		userId: user.id,
		role: user.role,
		tenantId,
	});
	const refreshToken = generateRefreshToken();
	const expiresIn = getRefreshTokenExpirySeconds();
	await storeRefreshToken(user.id, refreshToken, expiresIn);

	// No tenant scope on this route - it runs before authentication - so the tenant
	// the account was just created in is passed explicitly.
	await audit(c, { action: "auth.register", userId: user.id, tenantId });

	return c.json(
		{
			success: true as const,
			data: {
				user: {
					id: user.id,
					phone: user.phone,
					role: user.role,
					isActive: user.isActive,
					createdAt: user.createdAt.toISOString(),
				},
				accessToken,
				refreshToken,
			},
		},
		200
	);
};

export const loginHandler: AppRouteHandler<typeof login> = async (c) => {
	const { phone, password } = c.req.valid("json");

	// UNSCOPED ON PURPOSE, and the one lookup in the codebase that must be. The phone
	// is the platform-wide login identity, so this returns at most one row and THAT
	// ROW decides the tenant. There is no tenant to filter by yet - inventing one from
	// client input is precisely how a login lands in the wrong account.
	const user = await db.query.users.findFirst({
		where: eq(users.phone, phone),
	});

	if (!user) {
		throw invalidCredentials("Telefon raqami yoki parol noto'g'ri");
	}

	if (!user.isActive) {
		throw invalidCredentials("Foydalanuvchi hisobi faol emas");
	}

	const isValidPassword = await verifyPassword(password, user.passwordHash);

	if (!isValidPassword) {
		throw invalidCredentials("Telefon raqami yoki parol noto'g'ri");
	}

	// Checked AFTER the password, so the account's tenant status is never revealed to
	// somebody who cannot authenticate as it.
	await requireOperationalTenantForCredentials(user);

	// The tenant comes from the user's own row, never from the request: a tenant id
	// a client could send is a tenant id a client could change.
	const accessToken = await generateAccessToken({
		userId: user.id,
		role: user.role,
		tenantId: user.tenantId,
	});
	const refreshToken = generateRefreshToken();

	const expiresIn = getRefreshTokenExpirySeconds();
	await storeRefreshToken(user.id, refreshToken, expiresIn);

	// `users.last_login_at` ustuni 0001 migratsiyasidan beri mavjud edi, lekin
	// hech qachon yozilmagan — shuning uchun profil sahifasida "oxirgi kirish"
	// doimo bo'sh chiqardi. Bu yerda faqat yozib qo'yiladi; javob shakli
	// o'zgarmaydi. Eski yozuvlar NULL bo'lib qoladi va UI'da "ma'lumot yo'q"
	// deb ko'rsatiladi — nol yoki to'qib chiqarilgan sana bilan emas.
	await db
		.update(users)
		.set({ lastLoginAt: new Date() })
		// The tenant term comes from the row that was just authenticated, so this write
		// is scoped even though the handler runs before any request scope exists.
		.where(tenantWhere(users, user.tenantId, eq(users.id, user.id)));

	await audit(c, { action: "auth.login", userId: user.id, tenantId: user.tenantId });

	return c.json(
		{
			success: true as const,
			data: {
				user: {
					id: user.id,
					phone: user.phone,
					role: user.role,
					isActive: user.isActive,
					createdAt: user.createdAt.toISOString(),
				},
				accessToken,
				refreshToken,
			},
		},
		200
	);
};

export const refreshHandler: AppRouteHandler<typeof refresh> = async (c) => {
	const { refreshToken } = c.req.valid("json");

	let foundUser: UserRow | null = null;

	// Fast path: one Redis GET on the token -> userId reverse index.
	const ownerId = await findRefreshTokenOwner(refreshToken);
	if (ownerId) {
		const candidate = await db.query.users.findFirst({
			where: and(eq(users.id, ownerId), eq(users.isActive, true)),
		});
		// Still verify the per-user key exists: the index alone must not be enough
		// to authenticate, so a stale index entry cannot resurrect a revoked token.
		if (candidate && (await isRefreshTokenValid(candidate.id, refreshToken))) {
			foundUser = candidate;
		}
	}

	if (!foundUser) {
		// Legacy path for tokens issued before the reverse index existed. Loads all
		// active users and probes each one - O(users) Redis calls, which is exactly
		// what the index removes. Kept only so deploying this change does not log
		// existing sessions out; it disappears naturally as old tokens expire.
		//
		// It reads users across ALL tenants and that is not a leak: the only thing it
		// can match is a Redis key built from a user id and the exact opaque token the
		// caller already holds, so it can identify no account but the token's owner and
		// returns no row to anybody. Nothing about it may be reused as a lookup.
		const allUsers = await db.query.users.findMany({
			where: eq(users.isActive, true),
		});

		for (const user of allUsers) {
			const isValid = await isRefreshTokenValid(user.id, refreshToken);
			if (isValid) {
				foundUser = user;
				break;
			}
		}
	}

	if (!foundUser) {
		throw invalidCredentials("Refresh token yaroqsiz yoki muddati tugagan");
	}

	// A suspended or closed customer does not get a fresh access token either. Without
	// this, cutting an account off would take up to a full refresh cycle to bite.
	await requireOperationalTenantForCredentials(foundUser);

	await deleteRefreshToken(foundUser.id, refreshToken);

	// This is also the upgrade path for a token minted before tenancy: a v1 access
	// token is refused by verifyAccessToken(), the client refreshes as it already
	// does on any 401, and gets a tenant-aware token here.
	const newAccessToken = await generateAccessToken({
		userId: foundUser.id,
		role: foundUser.role,
		tenantId: foundUser.tenantId,
	});
	const newRefreshToken = generateRefreshToken();

	const expiresIn = getRefreshTokenExpirySeconds();
	await storeRefreshToken(foundUser.id, newRefreshToken, expiresIn);

	await audit(c, { action: "auth.refresh", userId: foundUser.id, tenantId: foundUser.tenantId });

	return c.json(
		{
			success: true as const,
			data: {
				user: {
					id: foundUser.id,
					phone: foundUser.phone,
					role: foundUser.role,
					isActive: foundUser.isActive,
					createdAt: foundUser.createdAt.toISOString(),
				},
				accessToken: newAccessToken,
				refreshToken: newRefreshToken,
			},
		},
		200
	);
};

export const logoutHandler: AppRouteHandler<typeof logout> = async (c) => {
	const user = c.get("user");
	const { refreshToken } = c.req.valid("json");

	await deleteRefreshToken(user.id, refreshToken);
	await audit(c, { action: "auth.logout" });

	return c.json(
		{
			success: true as const,
			data: {
				message: "Muvaffaqiyatli chiqildi",
			},
		},
		200
	);
};

export const changePasswordHandler: AppRouteHandler<typeof changePassword> = async (c) => {
	const authUser = c.get("user");
	const { currentPassword, newPassword } = c.req.valid("json");

	// tenantWhere puts the tenant first, matching idx_users_tenant_*; the id and the
	// tenant both come from the token and must agree.
	const user = await db.query.users.findFirst({
		where: tenantWhere(users, currentTenantId(c), eq(users.id, authUser.id)),
	});

	if (!user) {
		throw notFound("Foydalanuvchi", authUser.id);
	}

	const isCurrentValid = await verifyPassword(currentPassword, user.passwordHash);

	if (!isCurrentValid) {
		throw invalidCredentials("Hozirgi parol noto'g'ri");
	}

	// Rejecting a no-op change keeps the "all sessions revoked" side effect from
	// being triggered by an accidental resubmit.
	const isSamePassword = await verifyPassword(newPassword, user.passwordHash);

	if (isSamePassword) {
		throw invalidInput("newPassword", "Yangi parol hozirgi paroldan farq qilishi kerak");
	}

	const passwordHash = await hashPassword(newPassword);

	await db
		.update(users)
		.set({ passwordHash })
		.where(tenantWhere(users, user.tenantId, eq(users.id, user.id)));

	// A password change must invalidate every token minted under the old password,
	// on every device - otherwise rotating a leaked password changes nothing.
	await deleteAllUserTokens(user.id);

	await audit(c, { action: "auth.change_password" });

	return c.json(
		{
			success: true as const,
			data: {
				message: "Parol o'zgartirildi. Iltimos, qaytadan kiring.",
			},
		},
		200
	);
};

export const meHandler: AppRouteHandler<typeof me> = async (c) => {
	const authUser = c.get("user");

	const user = await db.query.users.findFirst({
		where: tenantWhere(users, currentTenantId(c), eq(users.id, authUser.id)),
	});

	if (!user) {
		throw notFound("Foydalanuvchi", authUser.id);
	}

	return c.json(
		{
			success: true as const,
			data: {
				id: user.id,
				phone: user.phone,
				role: user.role,
				isActive: user.isActive,
				createdAt: user.createdAt.toISOString(),
			},
		},
		200
	);
};
