import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { transcriptService } from "../services/transcript.service";
import type {
	AppendTranscriptLineRequest,
	TranscriptFilters,
	UpdateTranscriptLineRequest,
} from "../types/transcript";
import { callFullKey } from "./useCallFull";

export function useCallTranscript(callId: string, filters: TranscriptFilters) {
	return useQuery({
		queryKey: ["transcripts", callId, filters],
		queryFn: () => transcriptService.listByCall(callId, filters),
		enabled: !!callId,
	});
}

export function useAppendTranscriptLine(callId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: AppendTranscriptLineRequest) => transcriptService.append(callId, data),
		onSuccess: () => {
			message.success("Qator qo'shildi");
			queryClient.invalidateQueries({ queryKey: ["transcripts", callId] });
			queryClient.invalidateQueries({ queryKey: callFullKey(callId) });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Qatorni qo'shib bo'lmadi"));
		},
	});
}

export function useUpdateTranscriptLine(callId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateTranscriptLineRequest }) =>
			transcriptService.update(id, data),
		onSuccess: () => {
			message.success("Qator tuzatildi");
			queryClient.invalidateQueries({ queryKey: ["transcripts", callId] });
			queryClient.invalidateQueries({ queryKey: callFullKey(callId) });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Qatorni tuzatib bo'lmadi"));
		},
	});
}
