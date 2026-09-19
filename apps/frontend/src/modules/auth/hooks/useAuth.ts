import { useMutation } from "@tanstack/react-query";
import { App } from "antd";
import { useNavigate } from "react-router-dom";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { authService } from "../services/auth.service";
import { useAuthStore } from "../store/auth.store";
import type { LoginRequest } from "../types";

export function useLogin() {
	const { message } = App.useApp();
	const navigate = useNavigate();
	const setAuth = useAuthStore((state) => state.setAuth);

	return useMutation({
		mutationFn: (data: LoginRequest) => authService.login(data),
		onSuccess: (response) => {
			setAuth(response.user, response.accessToken, response.refreshToken);
			message.success("Tizimga kirdingiz");
			navigate("/dashboard");
		},
		onError: (error: unknown) => {
			// Backend AppError shaklini ham, oddiy { message } ni ham o'qiydi.
			message.error(getApiErrorMessage(error, "Telefon raqami yoki parol noto'g'ri"));
		},
	});
}

export function useLogout() {
	const { message } = App.useApp();
	const navigate = useNavigate();
	const { refreshToken, logout } = useAuthStore();

	return useMutation({
		mutationFn: () => {
			if (!refreshToken) {
				throw new Error("Refresh token yo'q");
			}
			return authService.logout({ refreshToken });
		},
		onSuccess: () => {
			logout();
			message.success("Tizimdan chiqdingiz");
			navigate("/login");
		},
		onError: () => {
			// Server javob bermasa ham mahalliy sessiyani tozalaymiz.
			logout();
			navigate("/login");
		},
	});
}

/**
 * Diqqat: sessiyani tiklash (hydrate + /auth/me) `src/App.tsx` ichidagi
 * `AuthInitializer` komponentida amalga oshiriladi. Shu sababli bu yerda
 * takrorlanuvchi `useMe` / `useAuthInit` hooklari yo'q — ular hech qayerdan
 * chaqirilmagan o'lik kod edi.
 */
