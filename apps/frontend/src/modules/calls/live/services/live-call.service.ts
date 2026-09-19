import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	AsteriskExtensionsResponse,
	HangupCallRequest,
	HangupCallResponse,
	LiveCallDetailResponse,
	LiveCallsResponse,
	TransferCallRequest,
	TransferCallResponse,
} from "../types";

export const liveCallService = {
	async list(): Promise<LiveCallsResponse> {
		const response = await apiClient.get<LiveCallsResponse>(API_ENDPOINTS.LIVE_CALLS.ROOT);
		return response.data;
	},

	async getById(id: string, transcriptLimit = 50): Promise<LiveCallDetailResponse> {
		const response = await apiClient.get<LiveCallDetailResponse>(
			API_ENDPOINTS.LIVE_CALLS.BY_ID(id),
			{ params: { transcriptLimit } }
		);
		return response.data;
	},

	async transfer(body: TransferCallRequest): Promise<TransferCallResponse> {
		const response = await apiClient.post<TransferCallResponse>(
			API_ENDPOINTS.ASTERISK.TRANSFER,
			body
		);
		return response.data;
	},

	async hangup(body: HangupCallRequest): Promise<HangupCallResponse> {
		const response = await apiClient.post<HangupCallResponse>(API_ENDPOINTS.ASTERISK.HANGUP, body);
		return response.data;
	},

	/** Transfer nishonlarini tanlash uchun: AMI holati bilan SIP extensionlar. */
	async listExtensions(): Promise<AsteriskExtensionsResponse> {
		const response = await apiClient.get<AsteriskExtensionsResponse>(
			API_ENDPOINTS.ASTERISK.EXTENSIONS
		);
		return response.data;
	},
};
