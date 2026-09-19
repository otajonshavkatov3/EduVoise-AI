import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	AiConfigPatch,
	AiConfigResponse,
	AiConfigUpdateResponse,
	AiSessionDetailResponse,
	AiSessionFilters,
	AiSessionsResponse,
	AiStatusResponse,
	AiVoicePreviewRequest,
	AiVoicePreviewResponse,
} from "../types";

export const aiAssistantService = {
	async getStatus(): Promise<AiStatusResponse> {
		const response = await apiClient.get<AiStatusResponse>(API_ENDPOINTS.AI_ASSISTANT.STATUS);
		return response.data;
	},

	async getConfig(): Promise<AiConfigResponse> {
		const response = await apiClient.get<AiConfigResponse>(API_ENDPOINTS.AI_ASSISTANT.CONFIG);
		return response.data;
	},

	async updateConfig(body: AiConfigPatch): Promise<AiConfigUpdateResponse> {
		const response = await apiClient.patch<AiConfigUpdateResponse>(
			API_ENDPOINTS.AI_ASSISTANT.CONFIG,
			body
		);
		return response.data;
	},

	/** Ovoz namunasi: WAV base64 ko'rinishida qaytadi, brauzer o'zi ijro etadi. */
	async previewVoice(body: AiVoicePreviewRequest): Promise<AiVoicePreviewResponse> {
		const response = await apiClient.post<AiVoicePreviewResponse>(
			API_ENDPOINTS.AI_ASSISTANT.VOICE_PREVIEW,
			body
		);
		return response.data;
	},

	async listSessions(filters: AiSessionFilters): Promise<AiSessionsResponse> {
		const response = await apiClient.get<AiSessionsResponse>(API_ENDPOINTS.AI_ASSISTANT.SESSIONS, {
			params: filters,
		});
		return response.data;
	},

	async getSession(id: string): Promise<AiSessionDetailResponse> {
		const response = await apiClient.get<AiSessionDetailResponse>(
			API_ENDPOINTS.AI_ASSISTANT.SESSION_BY_ID(id)
		);
		return response.data;
	},
};
