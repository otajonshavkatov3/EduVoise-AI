import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type { AuditFilters, AuditLogsResponse } from "../types";

export const auditService = {
	async list(filters: AuditFilters): Promise<AuditLogsResponse> {
		const response = await apiClient.get<AuditLogsResponse>(API_ENDPOINTS.AUDIT_LOGS.ROOT, {
			params: filters,
		});
		return response.data;
	},
};
