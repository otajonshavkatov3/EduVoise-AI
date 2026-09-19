import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { followUpService } from "../services/followUp.service";
import type { CreateFollowUpRequest, FollowUpFilters, UpdateFollowUpRequest } from "../types";

export function useFollowUps(filters: FollowUpFilters) {
	return useQuery({
		queryKey: ["follow-ups", "list", filters],
		queryFn: () => followUpService.list(filters),
	});
}

export function useCreateFollowUp() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateFollowUpRequest) => followUpService.create(data),
		onSuccess: () => {
			message.success("Vazifa yaratildi");
			queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Vazifani yaratib bo'lmadi"));
		},
	});
}

export function useUpdateFollowUp() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateFollowUpRequest }) =>
			followUpService.update(id, data),
		onSuccess: () => {
			message.success("Vazifa yangilandi");
			queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Vazifani yangilab bo'lmadi"));
		},
	});
}

export function useCancelFollowUp() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => followUpService.cancel(id),
		onSuccess: (text) => {
			message.success(text || "Vazifa bekor qilindi");
			queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Vazifani bekor qilib bo'lmadi"));
		},
	});
}
