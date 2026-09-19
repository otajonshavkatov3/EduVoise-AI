import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type { AnalysisCorrection, UpdateAiAnalysisRequest } from "../types/analysis";

/**
 * `GET /ai-analyses/{id}` javobining faqat shu sahifa o'qiydigan qismi.
 *
 * Qolgan maydonlari (xulosa, kayfiyat, transkript) `GET /calls/{id}/full` da
 * allaqachon bor; ularni ikkinchi marta e'lon qilish ikkita haqiqat manbaini
 * yaratardi.
 */
interface AnalysisProvenanceResponse {
	success: boolean;
	data: {
		lastCorrection: AnalysisCorrection | null;
		/** Mijoz nechta marta gapirgani — qayta tahlil shu shartga bog'liq. */
		callerTurnCount: number;
	};
}

export interface AnalysisProvenance {
	lastCorrection: AnalysisCorrection | null;
	callerTurnCount: number;
}

export const callAnalysisService = {
	/**
	 * Xulosa qo'lda tuzatilganmi va mijoz gapi bormi.
	 *
	 * Bu ikkisi `/calls/{id}/full` da yo'q: birinchisi audit loglardan yig'iladi,
	 * ikkinchisi esa saqlangan tahlil matnidan sanaladi.
	 */
	async provenance(analysisId: string): Promise<AnalysisProvenance> {
		const response = await apiClient.get<AnalysisProvenanceResponse>(
			API_ENDPOINTS.AI_ANALYSES.BY_ID(analysisId)
		);
		return {
			lastCorrection: response.data.data.lastCorrection,
			callerTurnCount: response.data.data.callerTurnCount,
		};
	},

	async update(analysisId: string, data: UpdateAiAnalysisRequest): Promise<void> {
		await apiClient.patch(API_ENDPOINTS.AI_ANALYSES.BY_ID(analysisId), data);
	},

	/** Xatolik bilan tugagan tahlilni qayta ishga tushiradi (transkript bo'lsa). */
	async retry(analysisId: string): Promise<void> {
		await apiClient.post(API_ENDPOINTS.AI_ANALYSES.RETRY(analysisId));
	},
};
