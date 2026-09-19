import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	AuthData,
	LoginRequest,
	LoginResponse,
	LogoutRequest,
	LogoutResponse,
	MeResponse,
	User,
} from "../types";

export const authService = {
	async login(data: LoginRequest): Promise<AuthData> {
		const response = await apiClient.post<LoginResponse>(API_ENDPOINTS.AUTH.LOGIN, data);
		return response.data.data;
	},

	async logout(data: LogoutRequest): Promise<void> {
		await apiClient.post<LogoutResponse>(API_ENDPOINTS.AUTH.LOGOUT, data);
	},

	async getMe(): Promise<User> {
		const response = await apiClient.get<MeResponse>(API_ENDPOINTS.AUTH.ME);
		return response.data.data;
	},
};
