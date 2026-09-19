import apiClient from "@/app/api/client";
import type {
	CostCallsFilters,
	CostCallsResponse,
	CostRatesResponse,
	CostSummaryFilters,
	CostSummaryResponse,
} from "../types";

const PATHS = {
	summary: "/ai-costs/summary",
	calls: "/ai-costs/calls",
	rates: "/ai-costs/rates",
} as const;

/** Bo'sh filtrlar so'rovga qo'shilmaydi — backend enum'lar bo'sh satrni rad etadi. */
function cleanParams(filters: object): Record<string, unknown> {
	const params: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(filters)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}

		params[key] = value;
	}

	return params;
}

export const aiCostService = {
	async summary(filters: CostSummaryFilters): Promise<CostSummaryResponse> {
		const response = await apiClient.get<CostSummaryResponse>(PATHS.summary, {
			params: cleanParams(filters),
		});

		return response.data;
	},

	async calls(filters: CostCallsFilters): Promise<CostCallsResponse> {
		const response = await apiClient.get<CostCallsResponse>(PATHS.calls, {
			params: cleanParams(filters),
		});

		return response.data;
	},

	async rates(range?: { from: string; to: string }): Promise<CostRatesResponse> {
		// observedModels is a claim about the loaded data, so it has to be scoped to
		// the same range as the figures it sits under.
		const response = await apiClient.get<CostRatesResponse>(PATHS.rates, { params: range });

		return response.data;
	},
};
