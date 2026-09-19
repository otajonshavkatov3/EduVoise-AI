import { useMutation, useQuery } from "@tanstack/react-query";
import { reportService } from "../services/report.service";
import type {
	AnyReportFilters,
	CallsReportFilters,
	ExportFormat,
	OperatorsReportFilters,
	ReportKind,
	TicketsReportFilters,
} from "../types";

/** Hisobotlar sof o'qish uchun — keshdan boshqa hech narsani buzmaydi. */
const REPORT_QUERY_OPTIONS = {
	staleTime: 30_000,
	retry: false,
} as const;

export function useCallsReport(filters: CallsReportFilters, enabled: boolean) {
	return useQuery({
		queryKey: ["reports", "calls", filters],
		queryFn: () => reportService.listCalls(filters),
		enabled,
		...REPORT_QUERY_OPTIONS,
	});
}

export function useTicketsReport(filters: TicketsReportFilters, enabled: boolean) {
	return useQuery({
		queryKey: ["reports", "tickets", filters],
		queryFn: () => reportService.listTickets(filters),
		enabled,
		...REPORT_QUERY_OPTIONS,
	});
}

export function useOperatorsReport(filters: OperatorsReportFilters, enabled: boolean) {
	return useQuery({
		queryKey: ["reports", "operators", filters],
		queryFn: () => reportService.listOperators(filters),
		enabled,
		...REPORT_QUERY_OPTIONS,
	});
}

export interface ExportVariables {
	kind: ReportKind;
	filters: AnyReportFilters;
	format: ExportFormat;
}

/**
 * Eksport mutatsiyasi. Xato xabari sahifada ko'rsatiladi (blob rejimidagi xato
 * javoblari service ichida matnga aylantiriladi), shuning uchun bu yerda
 * message chiqarilmaydi.
 */
export function useReportExport() {
	return useMutation({
		mutationFn: ({ kind, filters, format }: ExportVariables) =>
			reportService.export(kind, filters, format),
	});
}
