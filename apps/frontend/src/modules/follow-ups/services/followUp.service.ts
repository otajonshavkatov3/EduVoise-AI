import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	CancelFollowUpResponse,
	CreateFollowUpRequest,
	FollowUpFilters,
	FollowUpResponse,
	FollowUpsResponse,
	FollowUpTask,
	UpdateFollowUpRequest,
} from "../types";

export const followUpService = {
	async list(filters: FollowUpFilters): Promise<FollowUpsResponse> {
		const response = await apiClient.get<FollowUpsResponse>(API_ENDPOINTS.FOLLOW_UPS.ROOT, {
			params: filters,
		});
		return response.data;
	},

	async create(data: CreateFollowUpRequest): Promise<FollowUpTask> {
		const response = await apiClient.post<FollowUpResponse>(API_ENDPOINTS.FOLLOW_UPS.ROOT, data);
		return response.data.data;
	},

	async update(id: string, data: UpdateFollowUpRequest): Promise<FollowUpTask> {
		const response = await apiClient.patch<FollowUpResponse>(
			API_ENDPOINTS.FOLLOW_UPS.BY_ID(id),
			data
		);
		return response.data.data;
	},

	/** Vazifa o'chirilmaydi — status = cancelled qilinadi. */
	async cancel(id: string): Promise<string> {
		const response = await apiClient.delete<CancelFollowUpResponse>(
			API_ENDPOINTS.FOLLOW_UPS.BY_ID(id)
		);
		return response.data.data.message;
	},
};
