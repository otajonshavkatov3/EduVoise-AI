import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { callAnalysisService } from "../services/callAnalysis.service";
import type { UpdateAiAnalysisRequest } from "../types/analysis";
import { callFullKey } from "./useCallFull";

const NETWORK_MODE = "always" as const;

/**
 * Tuzatish izi va mijoz gapi soni.
 *
 * Alohida so'rov, chunki `/calls/{id}/full` bu ikkisini bermaydi. Xatosi yutiladi
 * — bu qo'shimcha ma'lumot, u kelmagani uchun butun karta yiqilmasligi kerak
 * (`retry: false` bilan bir marta urinadi).
 */
export function useAnalysisProvenance(analysisId: string | null) {
	return useQuery({
		queryKey: ["ai-analyses", "provenance", analysisId],
		queryFn: () => callAnalysisService.provenance(analysisId ?? ""),
		enabled: Boolean(analysisId),
		networkMode: NETWORK_MODE,
		retry: false,
		staleTime: 60_000,
	});
}

export function useUpdateCallAnalysis(callId: string) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateAiAnalysisRequest }) =>
			callAnalysisService.update(id, data),
		networkMode: NETWORK_MODE,
		onSuccess: () => {
			message.success("Tahlil tuzatildi");
			queryClient.invalidateQueries({ queryKey: callFullKey(callId) });
			queryClient.invalidateQueries({ queryKey: ["ai-analyses"] });
			// Murojaat kartasidagi ai_* ustunlari ham shu tahlildan to'ladi.
			queryClient.invalidateQueries({ queryKey: ["tickets"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Tahlilni tuzatib bo'lmadi"));
		},
	});
}

export function useRetryCallAnalysis(callId: string) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => callAnalysisService.retry(id),
		networkMode: NETWORK_MODE,
		onSuccess: () => {
			message.success("Tahlil qayta bajarildi");
			queryClient.invalidateQueries({ queryKey: ["tickets"] });
		},
		onError: (error: unknown) => {
			// Backend aniq sababni qaytaradi (transkript yo'q, model xatosi va h.k.)
			message.error(getApiErrorMessage(error, "Qayta tahlil qilib bo'lmadi"), 6);
		},
		onSettled: () => {
			// Muvaffaqiyatsiz urinishda ham retryCount va errorMessage o'zgaradi.
			queryClient.invalidateQueries({ queryKey: callFullKey(callId) });
			queryClient.invalidateQueries({ queryKey: ["ai-analyses"] });
		},
	});
}
