import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { operatorService } from "../services/operator.service";
import type { CreateOperatorRequest, UpdateOperatorRequest } from "../types";

export function useOperators(params?: { page?: number; limit?: number; includeDeleted?: boolean }) {
	return useQuery({
		queryKey: ["operators", params],
		queryFn: () =>
			operatorService.list({
				page: params?.page,
				limit: params?.limit,
				includeDeleted: params?.includeDeleted,
			}),
	});
}

export function useCreateOperator() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateOperatorRequest) => operatorService.create(data),
		onSuccess: () => {
			message.success("Operator profili yaratildi");
			queryClient.invalidateQueries({ queryKey: ["operators"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Operator profilini yaratib bo'lmadi"));
		},
	});
}

export function useUpdateOperator() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateOperatorRequest }) =>
			operatorService.update(id, data),
		onSuccess: () => {
			message.success("Operator profili saqlandi");
			queryClient.invalidateQueries({ queryKey: ["operators"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Operator profilini saqlab bo'lmadi"));
		},
	});
}

export function useRemoveOperator() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => operatorService.remove(id),
		onSuccess: () => {
			message.success("Operator profili o'chirildi");
			queryClient.invalidateQueries({ queryKey: ["operators"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Operator profilini o'chirib bo'lmadi"));
		},
	});
}
