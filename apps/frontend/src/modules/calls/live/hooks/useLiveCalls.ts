import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { liveCallService } from "../services/live-call.service";
import type { HangupCallRequest, TransferCallRequest } from "../types";

/** Doskaning asosiy so'rovi. WebSocket bo'lmasa ham ma'lumot yangilanib turadi. */
export function useLiveCallsQuery(enabled = true) {
	return useQuery({
		queryKey: ["live-calls", "list"],
		queryFn: () => liveCallService.list(),
		enabled,
		refetchInterval: 10_000,
		refetchOnWindowFocus: true,
		staleTime: 0,
		retry: false,
	});
}

/** Tanlangan qo'ng'iroq + oxirgi transkript qatorlari. */
export function useLiveCallDetail(callId: string | null, transcriptLimit = 50) {
	return useQuery({
		queryKey: ["live-calls", "detail", callId, transcriptLimit],
		queryFn: () => liveCallService.getById(callId as string, transcriptLimit),
		enabled: !!callId,
		staleTime: 0,
		retry: false,
	});
}

/** Transfer nishonlari. AMI o'chgan bo'lsa ham ro'yxat qaytadi. */
export function useAsteriskExtensions(enabled = true) {
	return useQuery({
		queryKey: ["asterisk", "extensions"],
		queryFn: () => liveCallService.listExtensions(),
		enabled,
		staleTime: 30_000,
		retry: false,
	});
}

export function useTransferCall() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (body: TransferCallRequest) => liveCallService.transfer(body),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["live-calls"] });
		},
	});
}

export function useHangupCall() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (body: HangupCallRequest) => liveCallService.hangup(body),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["live-calls"] });
		},
	});
}
