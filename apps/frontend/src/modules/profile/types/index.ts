import type { OperatorStatus } from "@/modules/operators/types";

/** `GET /users/me/profile` javobidagi operator qismi (bo'lmasa null). */
export interface MyOperatorProfile {
	id: string;
	extension: string;
	currentStatus: OperatorStatus;
	/** Holat oxirgi marta o'zgargan vaqt. Hech qachon o'zgarmagan bo'lsa null. */
	lastStatusChange: string | null;
	createdAt: string;
}

/** `GET /users/me/profile` javobi. */
export interface MyProfile {
	id: string;
	phone: string;
	username: string | null;
	email: string | null;
	role: "supervisor" | "admin" | "manager";
	isActive: boolean;
	/**
	 * Oxirgi muvaffaqiyatli kirish vaqti. Bu ustun avval hech qachon
	 * yozilmagani uchun eski hisoblarda null bo'ladi — UI'da "ma'lumot yo'q"
	 * deb ko'rsatiladi, nol yoki o'ylab topilgan sana bilan emas.
	 */
	lastLoginAt: string | null;
	createdAt: string;
	updatedAt: string;
	operator: MyOperatorProfile | null;
}

export interface MyProfileResponse {
	success: boolean;
	data: MyProfile;
}

/** `POST /auth/change-password` so'rovi. */
export interface ChangePasswordRequest {
	currentPassword: string;
	newPassword: string;
}

/**
 * Muvaffaqiyatli o'zgartirishdan keyin barcha qurilmalardagi sessiyalar bekor
 * qilinadi, shuning uchun UI foydalanuvchini qayta kirishga yuborishi kerak.
 */
export interface ChangePasswordResponse {
	success: boolean;
	data: { message: string };
}
