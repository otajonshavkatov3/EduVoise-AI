import { getClientEnv } from "@shared/env";
import type { RefreshResponse } from "@shared/types";
import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { API_ENDPOINTS } from "./endpoint";

const env = getClientEnv();

export const apiClient = axios.create({
	baseURL: `${env.VITE_API_URL}/api`,
	headers: {
		"Content-Type": "application/json",
	},
});

// Request interceptor - attach access token
apiClient.interceptors.request.use(
	(config: InternalAxiosRequestConfig) => {
		const accessToken = useAuthStore.getState().accessToken;
		if (accessToken) {
			config.headers.Authorization = `Bearer ${accessToken}`;
		}
		return config;
	},
	(error) => Promise.reject(error)
);

// Response interceptor - handle 401 and auto-refresh
apiClient.interceptors.response.use(
	(response) => response,
	async (error: AxiosError) => {
		const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

		// If 401 and not a retry and not a login request, try to refresh token
		if (
			error.response?.status === 401 &&
			!originalRequest._retry &&
			originalRequest.url !== API_ENDPOINTS.AUTH.LOGIN
		) {
			originalRequest._retry = true;

			const refreshToken = useAuthStore.getState().refreshToken;

			if (refreshToken) {
				try {
					const response = await axios.post<RefreshResponse>(
						`${env.VITE_API_URL}/api${API_ENDPOINTS.AUTH.REFRESH}`,
						{ refreshToken }
					);

					const { accessToken, refreshToken: newRefreshToken } = response.data.data;

					// Update store with new tokens
					useAuthStore.getState().setTokens(accessToken, newRefreshToken);

					// Retry original request with new token
					originalRequest.headers.Authorization = `Bearer ${accessToken}`;
					return apiClient(originalRequest);
				} catch {
					// Refresh failed - logout user
					useAuthStore.getState().logout();
					if (window.location.pathname !== "/login") {
						window.location.href = "/login";
					}
					return Promise.reject(error);
				}
			} else {
				// No refresh token - logout
				useAuthStore.getState().logout();
				if (window.location.pathname !== "/login") {
					window.location.href = "/login";
				}
			}
		}

		return Promise.reject(error);
	}
);

export default apiClient;
