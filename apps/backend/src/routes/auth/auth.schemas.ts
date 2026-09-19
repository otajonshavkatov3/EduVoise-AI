import { z } from "@hono/zod-openapi";

export const LoginSchema = z
	.object({
		phone: z.string().min(9).max(20).openapi({
			example: "+998901234567",
			description: "Telefon raqami",
		}),
		password: z.string().min(4).max(100).openapi({
			example: "password123",
			description: "Parol",
		}),
	})
	.openapi("LoginRequest");

export const RegisterSchema = z
	.object({
		phone: z.string().min(9).max(20).openapi({
			example: "+998901234567",
			description: "Telefon raqami",
		}),
		password: z.string().min(4).max(100).openapi({
			example: "password123",
			description: "Parol",
		}),
	})
	.openapi("RegisterRequest");

export const RefreshTokenSchema = z
	.object({
		refreshToken: z.string().min(1).openapi({
			example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
			description: "Refresh token",
		}),
	})
	.openapi("RefreshTokenRequest");

export const ChangePasswordSchema = z
	.object({
		currentPassword: z.string().min(4).max(100).openapi({
			example: "admin123",
			description: "Hozirgi parol",
		}),
		// 8 is the floor for a NEW password even though login accepts 4, because the
		// seeded default (admin123) must not be replaceable by something weaker.
		newPassword: z.string().min(8).max(100).openapi({
			example: "yangi_parol_2026",
			description: "Yangi parol (kamida 8 belgi)",
		}),
	})
	.openapi("ChangePasswordRequest");

export const UserSchema = z
	.object({
		id: z.string().uuid().openapi({
			example: "123e4567-e89b-12d3-a456-426614174000",
		}),
		phone: z.string().openapi({
			example: "+998901234567",
		}),
		role: z.enum(["supervisor", "admin", "manager", "vendor"]).openapi({
			example: "manager",
		}),
		isActive: z.boolean().openapi({
			example: true,
		}),
		createdAt: z.string().datetime().openapi({
			example: "2024-01-15T10:30:00.000Z",
		}),
	})
	.openapi("User");

export const AuthResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			user: UserSchema,
			accessToken: z.string().openapi({
				example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
			}),
			refreshToken: z.string().openapi({
				example: "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
			}),
		}),
	})
	.openapi("AuthResponse");

export const MeResponseSchema = z
	.object({
		success: z.literal(true),
		data: UserSchema,
	})
	.openapi("MeResponse");

export const MessageResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			message: z.string().openapi({
				example: "Successfully logged out",
			}),
		}),
	})
	.openapi("MessageResponse");

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type RefreshTokenInput = z.infer<typeof RefreshTokenSchema>;
export type UserOutput = z.infer<typeof UserSchema>;
