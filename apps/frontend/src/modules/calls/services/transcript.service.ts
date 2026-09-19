import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	AppendTranscriptLineRequest,
	TranscriptExportOptions,
	TranscriptFilters,
	TranscriptLine,
	TranscriptLineResponse,
	TranscriptsResponse,
	UpdateTranscriptLineRequest,
} from "../types/transcript";

export const transcriptService = {
	async listByCall(callId: string, filters: TranscriptFilters): Promise<TranscriptsResponse> {
		const response = await apiClient.get<TranscriptsResponse>(
			API_ENDPOINTS.TRANSCRIPTS.BY_CALL(callId),
			{ params: filters }
		);
		return response.data;
	},

	async append(callId: string, data: AppendTranscriptLineRequest): Promise<TranscriptLine> {
		const response = await apiClient.post<TranscriptLineResponse>(
			API_ENDPOINTS.TRANSCRIPTS.BY_CALL(callId),
			data
		);
		return response.data.data;
	},

	async update(id: string, data: UpdateTranscriptLineRequest): Promise<TranscriptLine> {
		const response = await apiClient.patch<TranscriptLineResponse>(
			API_ENDPOINTS.TRANSCRIPTS.BY_ID(id),
			data
		);
		return response.data.data;
	},

	/** Transkriptni txt yoki CSV sifatida yuklab olish */
	async export(callId: string, options: TranscriptExportOptions): Promise<Blob> {
		const response = await apiClient.get(API_ENDPOINTS.TRANSCRIPTS.EXPORT_BY_CALL(callId), {
			params: options,
			responseType: "blob",
		});
		return response.data;
	},
};
