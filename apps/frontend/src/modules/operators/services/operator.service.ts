import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	CreateOperatorRequest,
	ListOperatorsResponse,
	OperatorProfile,
	OperatorResponse,
	OperatorSipCredentials,
	OperatorSipResponse,
	UpdateOperatorRequest,
} from "../types";

export const operatorService = {
	/**
	 * `GET /operator-profiles` — server faqat `page`, `limit` va
	 * `includeDeleted` ni qo'llaydi. Holat bo'yicha filtr serverda yo'q, shu
	 * sababli u sahifa darajasida (mijoz tomonida) qo'llaniladi.
	 */
	async list(params?: {
		page?: number;
		limit?: number;
		includeDeleted?: boolean;
	}): Promise<ListOperatorsResponse> {
		const response = await apiClient.get<ListOperatorsResponse>(
			API_ENDPOINTS.OPERATOR_PROFILES.ROOT,
			{
				params: {
					page: params?.page,
					limit: params?.limit,
					includeDeleted: params?.includeDeleted ? "true" : "false",
				},
			}
		);
		return response.data;
	},

	async getMeProfile(): Promise<OperatorProfile> {
		const response = await apiClient.get<OperatorResponse>(API_ENDPOINTS.OPERATOR_PROFILES.ME);
		return response.data.data;
	},

	/**
	 * Shu operatorning brauzer softfoni uchun SIP hisob ma'lumotlari.
	 *
	 * 404 — foydalanuvchida operator profili yo'q (masalan supervisor).
	 * 409 — operatorning extension'iga brauzer jufti biriktirilmagan (1XX emas).
	 * Ikkala holatda ham chaqiruvchi registratsiya qilmasligi kerak.
	 */
	async getMySipCredentials(): Promise<OperatorSipCredentials> {
		const response = await apiClient.get<OperatorSipResponse>(
			API_ENDPOINTS.OPERATOR_PROFILES.ME_SIP
		);
		return response.data.data;
	},

	async get(id: string): Promise<OperatorProfile> {
		const response = await apiClient.get<OperatorResponse>(
			API_ENDPOINTS.OPERATOR_PROFILES.BY_ID(id)
		);
		return response.data.data;
	},

	async create(data: CreateOperatorRequest): Promise<OperatorProfile> {
		const response = await apiClient.post<OperatorResponse>(
			API_ENDPOINTS.OPERATOR_PROFILES.ROOT,
			data
		);
		return response.data.data;
	},

	async update(id: string, data: UpdateOperatorRequest): Promise<OperatorProfile> {
		const response = await apiClient.patch<OperatorResponse>(
			API_ENDPOINTS.OPERATOR_PROFILES.BY_ID(id),
			data
		);
		return response.data.data;
	},

	async updateMyStatus(status: string): Promise<OperatorProfile> {
		const response = await apiClient.patch<OperatorResponse>(
			API_ENDPOINTS.OPERATOR_PROFILES.ME_STATUS,
			{ status }
		);
		return response.data.data;
	},

	async remove(id: string): Promise<void> {
		await apiClient.delete(API_ENDPOINTS.OPERATOR_PROFILES.BY_ID(id));
	},
};
