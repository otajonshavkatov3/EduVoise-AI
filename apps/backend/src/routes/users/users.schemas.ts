import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, phoneSchema } from "@/lib";

/**
 * Roles a response may contain. Includes "vendor" because /users/me answers for a
 * vendor too - a platform owner reading their own profile while inside a customer's
 * account.
 */
export const userRoleEnum = z.enum(["supervisor", "admin", "manager", "vendor"]);

/**
 * Roles a REQUEST may set, and deliberately NOT the same list. "vendor" is a
 * platform-level role: a customer's own admin editing a user must not be able to
 * type it into the body and promote somebody above every tenant. The vendor role is
 * granted only by the vendor seed, never over HTTP.
 */
export const assignableUserRoleEnum = z.enum(["supervisor", "admin", "manager"]);

export const UpdateBodySchema = z.object({
	phone: phoneSchema.optional(),
	username: z.string().max(50).nullable().optional(),
	email: z.string().email().nullable().optional(),
	role: assignableUserRoleEnum.optional(),
	isActive: z.boolean().optional(),
});

export const UserItemSchema = z.object({
	id: z.string().uuid(),
	phone: z.string(),
	username: z.string().nullable(),
	email: z.string().nullable(),
	role: userRoleEnum,
	isActive: z.boolean(),
	isDeleted: z.boolean(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(UserItemSchema),
		meta: PaginationMetaSchema,
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: UserItemSchema,
});

export const RemoveOutSchema = z.object({
	success: z.literal(true),
	data: z.object({ message: z.string() }),
});

/**
 * Additive: joriy foydalanuvchining o'z profili. `GET /auth/me` javob shakli
 * o'zgartirilmasligi kerak bo'lgani uchun (mavjud mijozlar unga tayanadi),
 * profil sahifasi uchun kerak bo'lgan qo'shimcha maydonlar — username, email,
 * lastLoginAt va operator profili — shu yangi yo'l orqali beriladi.
 *
 * `lastLoginAt` va `lastStatusChange` NULL bo'lishi mumkin: birinchisi faqat
 * shu o'zgarishdan keyingi kirishlarda yoziladi, ikkinchisi esa operator holati
 * hech qachon o'zgartirilmagan bo'lsa bo'sh qoladi. Bo'sh qiymat nol yoki
 * to'qib chiqarilgan sana bilan almashtirilmaydi.
 */
export const MyOperatorProfileSchema = z.object({
	id: z.string().uuid(),
	extension: z.string(),
	currentStatus: z.enum(["online", "offline", "pause", "busy"]),
	lastStatusChange: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
});

export const MyProfileSchema = z.object({
	id: z.string().uuid(),
	phone: z.string(),
	username: z.string().nullable(),
	email: z.string().nullable(),
	role: userRoleEnum,
	isActive: z.boolean(),
	lastLoginAt: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	operator: MyOperatorProfileSchema.nullable(),
});

export const MyProfileOutSchema = z.object({
	success: z.literal(true),
	data: MyProfileSchema,
});

export const ListQuerySchema = z
	.object({
		role: userRoleEnum.optional(),
	})
	.merge(PaginationQuerySchema);

export type UpdateBody = z.infer<typeof UpdateBodySchema>;
