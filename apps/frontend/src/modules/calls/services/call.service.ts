import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type { CallFilters, CallsResponse, MeCallStatsResponse, SingleCallResponse } from "../types";
import type { CallFullResponse } from "../types/callFull";

export const callService = {
	async list(filters: CallFilters): Promise<CallsResponse> {
		const response = await apiClient.get<CallsResponse>(API_ENDPOINTS.CALLS.ROOT, {
			params: filters,
		});
		return response.data;
	},

	async listMissed(filters: CallFilters): Promise<CallsResponse> {
		const response = await apiClient.get<CallsResponse>(API_ENDPOINTS.CALLS.MISSED, {
			params: filters,
		});
		return response.data;
	},

	async getById(id: string): Promise<SingleCallResponse> {
		const response = await apiClient.get<SingleCallResponse>(API_ENDPOINTS.CALLS.BY_ID(id));
		return response.data;
	},

	/**
	 * Qo'ng'iroq kartasining butun mazmuni bitta so'rovda.
	 *
	 * `getById` dan alohida turadi: uni softphone oynasi va ro'yxat qatori
	 * chaqiradi, ularga esa transkript ham, xarajat ham kerak emas.
	 */
	async getFull(id: string, includeInterim: boolean): Promise<CallFullResponse> {
		const response = await apiClient.get<CallFullResponse>(API_ENDPOINTS.CALLS.FULL(id), {
			params: includeInterim ? { includeInterim: "true" } : undefined,
		});
		return response.data;
	},

	async export(filters: CallFilters): Promise<Blob> {
		// Omit pagination for full export
		const { page: _, limit: __, ...exportFilters } = filters;
		const response = await apiClient.get(API_ENDPOINTS.CALLS.EXPORT, {
			params: { ...exportFilters, format: "csv" },
			responseType: "blob",
		});
		return response.data;
	},

	async getMeStats(): Promise<MeCallStatsResponse> {
		const response = await apiClient.get<MeCallStatsResponse>(API_ENDPOINTS.CALLS.ME_STATS);
		return response.data;
	},
};
