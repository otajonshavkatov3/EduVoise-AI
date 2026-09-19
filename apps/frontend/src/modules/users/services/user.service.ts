import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	CreateUserRequest,
	DeleteUserResponse,
	RegisterUserResponse,
	SingleUserResponse,
	UpdateUserRequest,
	UserFilters,
	UsersResponse,
} from "../types";

export const userService = {
	async list(params?: UserFilters) {
		const { data } = await apiClient.get<UsersResponse>(API_ENDPOINTS.USERS.ROOT, {
			params,
		});
		return data;
	},

	async getById(id: string) {
		const { data } = await apiClient.get<SingleUserResponse>(API_ENDPOINTS.USERS.BY_ID(id));
		return data;
	},

	/**
	 * Yangi foydalanuvchi yaratish — mavjud ikkita endpoint ustida.
	 *
	 * 1. `POST /auth/register` (telefon + parol; rol har doim "manager").
	 * 2. Forma qo'shimcha maydon bergan bo'lsa — `PATCH /users/{id}`.
	 *
	 * Register javobidagi tokenlar ataylab e'tiborsiz qoldiriladi: joriy
	 * sessiya o'zgarmasligi kerak.
	 */
	async create(payload: CreateUserRequest) {
		const { data } = await apiClient.post<RegisterUserResponse>(API_ENDPOINTS.AUTH.REGISTER, {
			phone: payload.phone,
			password: payload.password,
		});

		const newUserId = data.data.user.id;

		const patch: UpdateUserRequest = {};
		if (payload.username) {
			patch.username = payload.username;
		}
		if (payload.email) {
			patch.email = payload.email;
		}
		if (payload.role && payload.role !== "manager") {
			patch.role = payload.role;
		}
		if (payload.isActive === false) {
			patch.isActive = false;
		}

		if (Object.keys(patch).length > 0) {
			return userService.update(newUserId, patch);
		}

		return userService.getById(newUserId);
	},

	async update(id: string, updateData: UpdateUserRequest) {
		const { data } = await apiClient.patch<SingleUserResponse>(
			API_ENDPOINTS.USERS.BY_ID(id),
			updateData
		);
		return data;
	},

	async remove(id: string) {
		const { data } = await apiClient.delete<DeleteUserResponse>(API_ENDPOINTS.USERS.BY_ID(id));
		return data;
	},
};
