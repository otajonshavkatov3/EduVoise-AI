import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	ChangePasswordRequest,
	ChangePasswordResponse,
	MyProfile,
	MyProfileResponse,
} from "../types";

/**
 * Literal path rather than an API_ENDPOINTS entry: app/api/endpoint.ts has no
 * auth section, and adding one there would touch a file shared by every module.
 */
const CHANGE_PASSWORD_PATH = "/auth/change-password";

export const profileService = {
	async getMyProfile(): Promise<MyProfile> {
		const { data } = await apiClient.get<MyProfileResponse>(API_ENDPOINTS.USERS.ME_PROFILE);
		return data.data;
	},

	async changePassword(body: ChangePasswordRequest): Promise<ChangePasswordResponse> {
		const { data } = await apiClient.post<ChangePasswordResponse>(CHANGE_PASSWORD_PATH, body);
		return data;
	},
};
