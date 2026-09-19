import apiClient from "@/app/api/client";
import type {
	SettingsResponse,
	SettingsUpdateRequest,
	SettingsUpdateResponse,
	TelegramTestRequest,
	TelegramTestResponse,
} from "../types";

/**
 * Declared here rather than in app/api/endpoint.ts because that file is shared
 * and owned elsewhere. Moving these three entries into API_ENDPOINTS.SETTINGS is
 * a safe follow-up; nothing else references them.
 */
const SETTINGS_ENDPOINTS = {
	ROOT: "/settings",
	TEST_TELEGRAM: "/settings/test/telegram",
} as const;

export const settingsService = {
	async list(): Promise<SettingsResponse> {
		const response = await apiClient.get<SettingsResponse>(SETTINGS_ENDPOINTS.ROOT);
		return response.data;
	},

	async update(body: SettingsUpdateRequest): Promise<SettingsUpdateResponse> {
		const response = await apiClient.patch<SettingsUpdateResponse>(SETTINGS_ENDPOINTS.ROOT, body);
		return response.data;
	},

	async testTelegram(body: TelegramTestRequest): Promise<TelegramTestResponse> {
		const response = await apiClient.post<TelegramTestResponse>(
			SETTINGS_ENDPOINTS.TEST_TELEGRAM,
			body
		);
		return response.data;
	},
};
