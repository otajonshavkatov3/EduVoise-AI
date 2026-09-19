import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { callService } from "../services/call.service";
import type { CallFilters, CallsResponse } from "../types";

export function useCalls(
	filters: CallFilters,
	enabled = true,
	options?: Partial<UseQueryOptions<CallsResponse>>
) {
	return useQuery({
		queryKey: ["calls", "list", filters],
		queryFn: () => callService.list(filters),
		enabled,
		...options,
	});
}

export function useMissedCalls(filters: CallFilters) {
	return useQuery({
		queryKey: ["calls", "missed", filters],
		queryFn: () => callService.listMissed(filters),
	});
}

export function useCall(id: string) {
	return useQuery({
		queryKey: ["calls", "detail", id],
		queryFn: () => callService.getById(id),
		enabled: !!id,
	});
}
