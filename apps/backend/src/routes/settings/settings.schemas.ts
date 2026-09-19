import { z } from "@hono/zod-openapi";

import { SETTING_CATEGORIES } from "@/lib/settings";

/** Settings are scalars by design - see lib/settings/registry.ts. */
export const SettingValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const settingValueTypeEnum = z.enum(["string", "number", "boolean", "secret"]);

export const settingCategoryEnum = z.enum(SETTING_CATEGORIES);

export const SettingItemSchema = z
	.object({
		key: z.string(),
		category: settingCategoryEnum,
		/** "secret" renders as a password input and is never returned in the clear. */
		type: settingValueTypeEnum,
		label: z.string(),
		description: z.string(),
		/** For a secret this is the mask when a value exists, otherwise an empty string. */
		value: SettingValueSchema,
		isSecret: z.boolean(),
		/**
		 * The effective value is non-empty. For a secret this is the only signal the
		 * UI gets that a token exists. Always true for a number or a boolean.
		 */
		isSet: z.boolean(),
		/** No row stored yet - the registry default is in effect. */
		isDefault: z.boolean(),
		updatedAt: z.string().datetime().nullable(),
	})
	.openapi("SettingItem");

export const SettingCategoryGroupSchema = z
	.object({
		category: settingCategoryEnum,
		label: z.string(),
		items: z.array(SettingItemSchema),
	})
	.openapi("SettingCategoryGroup");

export const SettingsPayloadSchema = z
	.object({
		/** True only for a supervisor. Everyone else reads. */
		canEdit: z.boolean(),
		/** The literal string returned in place of a stored secret. */
		secretMask: z.string(),
		/** Role-dependent: "pricing" is served only to the roles /api/ai-costs allows. */
		categories: z.array(SettingCategoryGroupSchema),
	})
	.openapi("SettingsPayload");

export const GetOutSchema = z.object({
	success: z.literal(true),
	data: SettingsPayloadSchema,
});

export const UpdateBodySchema = z
	.object({
		/**
		 * Only the keys being changed. A secret whose value equals the mask is
		 * ignored, so a form may safely echo back what it was given; sending an
		 * empty string clears the stored secret.
		 */
		values: z
			.record(z.string(), SettingValueSchema)
			.refine((values) => Object.keys(values).length > 0, {
				message: "Kamida bitta sozlama yuborilishi kerak",
			}),
	})
	.openapi("SettingsUpdateBody");

export const UpdateOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		/** Keys whose effective value actually changed. */
		changed: z.array(z.string()),
		settings: SettingsPayloadSchema,
	}),
});

export const TelegramTestBodySchema = z
	.object({
		/** Overrides the stored token for this test only. Nothing is saved. */
		botToken: z.string().max(200).optional(),
		chatId: z.string().max(120).optional(),
		message: z.string().max(500).optional(),
	})
	.openapi("SettingsTelegramTestBody");

export const TelegramTestOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		ok: z.boolean(),
		botUsername: z.string().nullable(),
		/** True only when a real message reached the configured chat. */
		messageSent: z.boolean(),
		detail: z.string(),
		checkedAt: z.string().datetime(),
	}),
});

export type UpdateBody = z.infer<typeof UpdateBodySchema>;
export type TelegramTestBody = z.infer<typeof TelegramTestBodySchema>;
export type SettingItem = z.infer<typeof SettingItemSchema>;
export type SettingsPayload = z.infer<typeof SettingsPayloadSchema>;
