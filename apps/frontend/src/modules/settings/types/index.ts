/**
 * Mirrors apps/backend/src/routes/settings/settings.schemas.ts.
 *
 * The Settings page is driven entirely by this metadata: the backend registry
 * decides which fields exist, what they are called and how they render, so a new
 * setting appears here without a frontend change.
 */

export type SettingValue = string | number | boolean;

export type SettingValueType = "string" | "number" | "boolean" | "secret";

export type SettingCategory = "general" | "pricing" | "notifications";

export interface SettingItem {
	key: string;
	category: SettingCategory;
	type: SettingValueType;
	label: string;
	description: string;
	/** For a secret: the mask when a value is stored, otherwise an empty string. */
	value: SettingValue;
	isSecret: boolean;
	/** A non-empty value exists. The only signal the UI gets about a secret. */
	isSet: boolean;
	/** Nothing stored yet — the backend default is in effect. */
	isDefault: boolean;
	updatedAt: string | null;
}

export interface SettingCategoryGroup {
	category: SettingCategory;
	label: string;
	items: SettingItem[];
}

export interface SettingsPayload {
	/** True only for a supervisor. Every other role gets a read-only form. */
	canEdit: boolean;
	/** The literal the backend returns instead of a stored secret, e.g. "***". */
	secretMask: string;
	categories: SettingCategoryGroup[];
}

export interface SettingsResponse {
	success: true;
	data: SettingsPayload;
}

export interface SettingsUpdateRequest {
	values: Record<string, SettingValue>;
}

export interface SettingsUpdateResponse {
	success: true;
	data: {
		changed: string[];
		settings: SettingsPayload;
	};
}

export interface TelegramTestRequest {
	botToken?: string;
	chatId?: string;
	message?: string;
}

export interface TelegramTestResult {
	ok: boolean;
	botUsername: string | null;
	messageSent: boolean;
	detail: string;
	checkedAt: string;
}

export interface TelegramTestResponse {
	success: true;
	data: TelegramTestResult;
}
