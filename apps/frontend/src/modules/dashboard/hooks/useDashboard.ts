import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { dashboardService } from "../services/dashboard.service";
import type { DashboardPeriod } from "../types";

/** Dashboard jonli panel — 30 sekundda bir yangilanadi. */
const REFETCH_MS = 30_000;

/**
 * Davr almashganda oldingi natija ekranda qoladi (keepPreviousData) — skeleton
 * "chaqnashi" va grafikning sakrab qayta chizilishi bo'lmaydi.
 */
export function useDashboardOverview(period: DashboardPeriod) {
	return useQuery({
		queryKey: ["dashboard", "overview", period],
		queryFn: () => dashboardService.getOverview(period),
		refetchInterval: REFETCH_MS,
		refetchOnWindowFocus: true,
		placeholderData: keepPreviousData,
		retry: false,
	});
}

export function useDashboardCallVolume(period: DashboardPeriod) {
	return useQuery({
		queryKey: ["dashboard", "call-volume", period],
		queryFn: () => dashboardService.getCallVolume(period),
		refetchInterval: REFETCH_MS,
		refetchOnWindowFocus: true,
		placeholderData: keepPreviousData,
		retry: false,
	});
}

export function useDashboardMissedCalls(period: DashboardPeriod, limit = 10) {
	return useQuery({
		queryKey: ["dashboard", "missed-calls", period, limit],
		queryFn: () => dashboardService.getMissedCalls(period, limit),
		refetchInterval: REFETCH_MS,
		refetchOnWindowFocus: true,
		placeholderData: keepPreviousData,
		retry: false,
	});
}
