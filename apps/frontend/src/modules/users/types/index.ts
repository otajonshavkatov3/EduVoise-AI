/**
 * Backenddagi `user_role` enum bilan bir xil. "operator" roli yo'q — u faqat
 * frontendda mavjud edi va tanlansa `PATCH /users/{id}` 400 qaytarardi.
 * Operatorlik alohida `operator_profiles` yozuvi bilan beriladi.
 */
export type UserRole = "supervisor" | "admin" | "manager";

export interface User {
	id: string;
	phone: string;
	username: string | null;
	email: string | null;
	role: UserRole;
	isActive: boolean;
	isDeleted: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface UserFilters {
	role?: UserRole;
	page?: number;
	limit?: number;
}

export interface UsersResponse {
	success: boolean;
	data: {
		items: User[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
	};
}

export interface SingleUserResponse {
	success: boolean;
	data: User;
}

/**
 * Yangi foydalanuvchi yaratish uchun forma qiymatlari.
 *
 * Backendda alohida "create user" yo'li yo'q: mavjud `POST /auth/register`
 * faqat telefon + parol qabul qiladi va rolni har doim "manager" qilib
 * yaratadi. Qolgan maydonlar shundan keyin `PATCH /users/{id}` bilan yoziladi
 * (`userService.create` ikkisini birlashtiradi).
 */
export interface CreateUserRequest {
	phone: string;
	password: string;
	username?: string | null;
	email?: string | null;
	role?: UserRole;
	isActive?: boolean;
}

export interface RegisterUserResponse {
	success: boolean;
	data: {
		user: {
			id: string;
			phone: string;
			role: UserRole;
			isActive: boolean;
			createdAt: string;
		};
		accessToken: string;
		refreshToken: string;
	};
}

export interface UpdateUserRequest {
	email?: string | null;
	isActive?: boolean;
	phone?: string;
	role?: UserRole;
	username?: string | null;
}

export interface DeleteUserResponse {
	success: boolean;
	data: {
		message: string;
	};
}
