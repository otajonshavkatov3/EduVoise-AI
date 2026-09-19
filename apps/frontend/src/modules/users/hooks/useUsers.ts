import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { userService } from "../services/user.service";
import type { CreateUserRequest, UpdateUserRequest, UserFilters } from "../types";

export function useUsers(params?: UserFilters) {
	return useQuery({
		queryKey: ["users", params],
		queryFn: () => userService.list(params),
	});
}

export function useCreateUser() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateUserRequest) => userService.create(data),
		onSuccess: () => {
			message.success("Foydalanuvchi yaratildi");
			queryClient.invalidateQueries({ queryKey: ["users"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Foydalanuvchini yaratib bo'lmadi"));
			// Register o'tib, keyingi PATCH yiqilgan bo'lishi mumkin — ro'yxatni
			// yangilab, haqiqiy holatni ko'rsatamiz.
			queryClient.invalidateQueries({ queryKey: ["users"] });
		},
	});
}

export function useUpdateUser() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateUserRequest }) =>
			userService.update(id, data),
		onSuccess: () => {
			message.success("Foydalanuvchi ma'lumotlari saqlandi");
			queryClient.invalidateQueries({ queryKey: ["users"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Foydalanuvchini saqlab bo'lmadi"));
		},
	});
}

export function useDeleteUser() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => userService.remove(id),
		onSuccess: () => {
			message.success("Foydalanuvchi o'chirildi");
			queryClient.invalidateQueries({ queryKey: ["users"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Foydalanuvchini o'chirib bo'lmadi"));
		},
	});
}
