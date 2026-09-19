import { getClientEnv } from "@shared/env";
import type { RefreshResponse } from "@shared/types";
import axios from "axios";
import { create } from "zustand";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import {
	clearStoredTokens,
	getStoredAccessToken,
	getStoredRefreshToken,
	setStoredTokens,
} from "@/shared/utils/token";
import type { User } from "../types";

interface AuthState {
	user: User | null;
	accessToken: string | null;
	refreshToken: string | null;
	isAuthenticated: boolean;
	isLoading: boolean;
}

interface AuthActions {
	setAuth: (user: User, accessToken: string, refreshToken: string) => void;
	setTokens: (accessToken: string, refreshToken: string) => void;
	setUser: (user: User) => void;
	setLoading: (loading: boolean) => void;
	logout: () => void;
	hydrate: () => void;
	/**
	 * Access tokenni `/auth/refresh` orqali yangilaydi va yangisini qaytaradi
	 * (yoki `null`). Xom `axios` ishlatiladi — `apiClient` interceptori bilan
	 * rekursiyaga tushmasligi uchun. Muvaffaqiyatsizlikda TIZIMDAN CHIQARMAYDI:
	 * WebSocket qayta ulanishi uchun chaqiriladi, oddiy API 401 oqimi esa
	 * chiqarishni o'zi hal qiladi.
	 */
	refresh: () => Promise<string | null>;
}

type AuthStore = AuthState & AuthActions;

export const useAuthStore = create<AuthStore>((set, get) => ({
	user: null,
	accessToken: null,
	refreshToken: null,
	isAuthenticated: false,
	isLoading: true,

	setAuth: (user, accessToken, refreshToken) => {
		setStoredTokens(accessToken, refreshToken);
		set({
			user,
			accessToken,
			refreshToken,
			isAuthenticated: true,
			isLoading: false,
		});
	},

	setTokens: (accessToken, refreshToken) => {
		setStoredTokens(accessToken, refreshToken);
		set({ accessToken, refreshToken });
	},

	setUser: (user) => {
		set({ user, isAuthenticated: true, isLoading: false });
	},

	setLoading: (loading) => {
		set({ isLoading: loading });
	},

	logout: () => {
		clearStoredTokens();
		set({
			user: null,
			accessToken: null,
			refreshToken: null,
			isAuthenticated: false,
			isLoading: false,
		});
	},

	hydrate: () => {
		const accessToken = getStoredAccessToken();
		const refreshToken = getStoredRefreshToken();

		if (accessToken && refreshToken) {
			set({
				accessToken,
				refreshToken,
				isLoading: true,
			});
		} else {
			set({ isLoading: false });
		}
	},

	refresh: async () => {
		const refreshToken = get().refreshToken ?? getStoredRefreshToken();
		if (!refreshToken) {
			return null;
		}
		try {
			const env = getClientEnv();
			const response = await axios.post<RefreshResponse>(
				`${env.VITE_API_URL}/api${API_ENDPOINTS.AUTH.REFRESH}`,
				{ refreshToken }
			);
			const { accessToken, refreshToken: newRefreshToken } = response.data.data;
			get().setTokens(accessToken, newRefreshToken);
			return accessToken;
		} catch {
			return null;
		}
	},
}));
