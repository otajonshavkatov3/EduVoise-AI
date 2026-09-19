import { useQuery } from "@tanstack/react-query";
import { aiCostService } from "../services/aiCost.service";
import type { CostCallsFilters, CostSummaryFilters } from "../types";

/** Sof o'qish — hech qanday keshni buzmaydi. */
const COST_QUERY_OPTIONS = {
	staleTime: 30_000,
	retry: false,
} as const;

export function useAiCostSummary(filters: CostSummaryFilters, enabled: boolean) {
	return useQuery({
		queryKey: ["ai-costs", "summary", filters],
		queryFn: () => aiCostService.summary(filters),
		enabled,
		...COST_QUERY_OPTIONS,
	});
}

export function useAiCostCalls(filters: CostCallsFilters, enabled: boolean) {
	return useQuery({
		queryKey: ["ai-costs", "calls", filters],
		queryFn: () => aiCostService.calls(filters),
		enabled,
		...COST_QUERY_OPTIONS,
	});
}

export function useAiCostRates(range: { from: string; to: string }, enabled: boolean) {
	return useQuery({
		queryKey: ["ai-costs", "rates", range],
		queryFn: () => aiCostService.rates(range),
		enabled,
		...COST_QUERY_OPTIONS,
	});
}
