import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { knowledgeBaseService } from "../services/knowledgeBase.service";
import type {
	BulkEntryInput,
	CreateKnowledgeEntryRequest,
	KnowledgeBaseFilters,
	UpdateKnowledgeEntryRequest,
} from "../types";

const KB_KEY = ["knowledge-base"] as const;

export function useKnowledgeEntries(filters: KnowledgeBaseFilters) {
	return useQuery({
		queryKey: [...KB_KEY, "list", filters],
		queryFn: () => knowledgeBaseService.list(filters),
		retry: false,
	});
}

/** `profileId` berilmasa aktiv profil statistikasi keladi. */
export function useKnowledgeStats(profileId?: string) {
	return useQuery({
		queryKey: [...KB_KEY, "stats", profileId ?? "active"],
		queryFn: () => knowledgeBaseService.stats(profileId),
		staleTime: 30_000,
		retry: false,
	});
}

function useKnowledgeInvalidator() {
	const queryClient = useQueryClient();

	return () => {
		queryClient.invalidateQueries({ queryKey: KB_KEY });
	};
}

export function useCreateKnowledgeEntry() {
	const invalidate = useKnowledgeInvalidator();

	return useMutation({
		mutationFn: (body: CreateKnowledgeEntryRequest) => knowledgeBaseService.create(body),
		onSuccess: () => {
			message.success("Yozuv qo'shildi — AI endi shu javobni aytishi mumkin");
			invalidate();
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Yozuvni qo'shib bo'lmadi"));
		},
	});
}

export function useUpdateKnowledgeEntry() {
	const invalidate = useKnowledgeInvalidator();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateKnowledgeEntryRequest }) =>
			knowledgeBaseService.update(id, data),
		onSuccess: () => {
			invalidate();
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Yozuvni saqlab bo'lmadi"));
		},
	});
}

export function useDeleteKnowledgeEntry() {
	const invalidate = useKnowledgeInvalidator();

	return useMutation({
		mutationFn: (id: string) => knowledgeBaseService.remove(id),
		onSuccess: () => {
			message.success("Yozuv o'chirildi");
			invalidate();
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Yozuvni o'chirib bo'lmadi"));
		},
	});
}

export function useBulkImportKnowledge() {
	const invalidate = useKnowledgeInvalidator();

	return useMutation({
		mutationFn: ({ entries, profileId }: { entries: BulkEntryInput[]; profileId?: string }) =>
			knowledgeBaseService.bulkImport(entries, profileId),
		onSuccess: () => {
			invalidate();
		},
	});
}

/**
 * Sinov qidiruvi.
 *
 * Mutation sifatida yozilgan, chunki natija tugma bosilganda kerak — avtomatik
 * qayta so'rov yoki kesh kerak emas.
 */
export function useKnowledgeSearch() {
	return useMutation({
		mutationFn: ({
			query,
			limit,
			profileId,
		}: {
			query: string;
			limit: number;
			profileId?: string;
		}) => knowledgeBaseService.search(query, limit, profileId),
	});
}
