import { useMutation, useQuery } from "@tanstack/react-query";
import { profileService } from "../services/profile.service";
import type { ChangePasswordRequest } from "../types";

/** Joriy foydalanuvchining o'z profili (`GET /users/me/profile`). */
export function useMyProfile() {
	return useQuery({
		queryKey: ["profile", "me"],
		queryFn: () => profileService.getMyProfile(),
		staleTime: 60_000,
	});
}

/**
 * Parolni o'zgartirish.
 *
 * Backend muvaffaqiyatdan keyin barcha refresh tokenlarni bekor qiladi, ya'ni
 * joriy sessiya ham yaroqsiz bo'ladi. Shuning uchun chaqiruvchi komponent
 * muvaffaqiyatdan keyin foydalanuvchini login sahifasiga yuborishi kerak —
 * aks holda keyingi so'rov 401 bilan tushadi va sababi tushunarsiz bo'ladi.
 */
export function useChangePassword() {
	return useMutation({
		mutationFn: (body: ChangePasswordRequest) => profileService.changePassword(body),
	});
}
