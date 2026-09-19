import { Spin } from "antd";
import { useEffect } from "react";
import { Providers } from "./app/providers";
import { AppRouter } from "./app/router";
import { authService } from "./modules/auth/services/auth.service";
import { useAuthStore } from "./modules/auth/store/auth.store";
import { getApiErrorStatus } from "./shared/utils/apiError";

/**
 * Sahifa yuklanganda saqlangan tokenlarni tiklaydi va `/auth/me` bilan
 * foydalanuvchini oladi.
 *
 * Muhim: saqlangan tokenlar faqat 401/403 da tozalanadi. Avval ISTALGAN xato
 * (masalan backend qayta ishga tushayotgan payt yoki tarmoq uzilishi) tokenlarni
 * localStorage'dan o'chirib tashlardi. Endi bunday holatda tokenlar joyida
 * qoladi — server qaytgach sahifani yangilash kifoya, qaytadan login qilish
 * shart emas.
 */
function AuthInitializer({ children }: { children: React.ReactNode }) {
	const { hydrate, setUser, setLoading, logout, accessToken, isLoading } = useAuthStore();

	useEffect(() => {
		const initAuth = async () => {
			hydrate();

			const currentToken = useAuthStore.getState().accessToken;
			if (!currentToken) {
				setLoading(false);
				return;
			}

			try {
				const user = await authService.getMe();
				setUser(user);
			} catch (error) {
				const status = getApiErrorStatus(error);
				if (status === 401 || status === 403) {
					logout();
					return;
				}
				// Tarmoq/server xatosi: sessiya saqlanadi, yuklanish tugatiladi.
				// ProtectedRoute tokenga qarab ishlaydi, so'rovlar esa keyin
				// qayta urinib ko'riladi.
				setLoading(false);
			}
		};

		initAuth();
	}, [hydrate, setUser, setLoading, logout]);

	if (isLoading && accessToken) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<Spin size="large" />
			</div>
		);
	}

	return <>{children}</>;
}

function App() {
	return (
		<Providers>
			<AuthInitializer>
				<AppRouter />
			</AuthInitializer>
		</Providers>
	);
}

export default App;
