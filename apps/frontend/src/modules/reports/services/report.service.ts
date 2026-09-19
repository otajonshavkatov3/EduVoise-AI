import apiClient from "@/app/api/client";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import type {
	AnyReportFilters,
	CallsReportFilters,
	CallsReportResponse,
	ExportedFile,
	ExportFormat,
	OperatorsReportFilters,
	OperatorsReportResponse,
	ReportKind,
	TicketsReportFilters,
	TicketsReportResponse,
} from "../types";

/**
 * Hisobot yo'llari shu modulda saqlanadi: app/api/endpoint.ts umumiy fayl va
 * uni boshqa ega yuritadi. Registratsiyadan keyin o'sha faylga ko'chirilishi mumkin.
 */
const REPORT_PATHS: Record<ReportKind, { list: string; export: string; fileBase: string }> = {
	calls: {
		list: "/reports/calls",
		export: "/reports/calls/export",
		fileBase: "qongiroqlar-hisoboti",
	},
	tickets: {
		list: "/reports/tickets",
		export: "/reports/tickets/export",
		fileBase: "murojaatlar-hisoboti",
	},
	operators: {
		list: "/reports/operators",
		export: "/reports/operators/export",
		fileBase: "operatorlar-hisoboti",
	},
};

/**
 * Bo'sh filtrlar so'rovga qo'shilmasligi kerak (backend enum'lar bo'sh satrni
 * rad etadi). Parametr `object`: filtr interfeyslarida indeks imzosi yo'q,
 * shuning uchun ular `Record<string, unknown>` sifatida qabul qilinmaydi.
 */
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

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

/**
 * Content-Disposition CORS sababli brauzerga ochilmasligi mumkin (backend
 * `origin: "*"` bilan ishlaydi va bu sarlavhani expose qilmaydi), shuning uchun
 * mavjud bo'lsa o'qiladi, aks holda server bilan bir xil qoidada yasaladi.
 */
function resolveFileName(
	headers: unknown,
	kind: ReportKind,
	format: ExportFormat,
	filters: { from: string; to: string }
): string {
	const disposition = (headers as Record<string, unknown> | undefined)?.["content-disposition"];

	if (typeof disposition === "string") {
		const match = /filename="([^"]+)"/.exec(disposition);

		if (match?.[1]) {
			return match[1];
		}
	}

	return `${REPORT_PATHS[kind].fileBase}_${dateOnly(filters.from)}_${dateOnly(filters.to)}.${format}`;
}

/**
 * responseType "blob" bo'lganda xato javobi ham Blob bo'lib keladi, shuning
 * uchun matnini o'qib backend xabarini chiqaramiz (masalan "oraliq juda katta").
 */
export async function readExportError(error: unknown, fallback: string): Promise<string> {
	const data = (error as { response?: { data?: unknown } } | undefined)?.response?.data;

	if (data instanceof Blob) {
		try {
			const parsed = JSON.parse(await data.text()) as {
				error?: { message?: string };
				message?: string;
			};

			return parsed.error?.message ?? parsed.message ?? fallback;
		} catch {
			return fallback;
		}
	}

	return getApiErrorMessage(error, fallback);
}

export const reportService = {
	async listCalls(filters: CallsReportFilters): Promise<CallsReportResponse> {
		const response = await apiClient.get<CallsReportResponse>(REPORT_PATHS.calls.list, {
			params: cleanParams(filters),
		});

		return response.data;
	},

	async listTickets(filters: TicketsReportFilters): Promise<TicketsReportResponse> {
		const response = await apiClient.get<TicketsReportResponse>(REPORT_PATHS.tickets.list, {
			params: cleanParams(filters),
		});

		return response.data;
	},

	async listOperators(filters: OperatorsReportFilters): Promise<OperatorsReportResponse> {
		const response = await apiClient.get<OperatorsReportResponse>(REPORT_PATHS.operators.list, {
			params: cleanParams(filters),
		});

		return response.data;
	},

	/** Eksport butun oraliqni oladi — sahifalash parametrlari yuborilmaydi. */
	async export(
		kind: ReportKind,
		filters: AnyReportFilters,
		format: ExportFormat
	): Promise<ExportedFile> {
		const { page: _page, limit: _limit, ...rest } = filters;
		const response = await apiClient.get<Blob>(REPORT_PATHS[kind].export, {
			params: cleanParams({ ...rest, format }),
			responseType: "blob",
		});

		return {
			blob: response.data,
			fileName: resolveFileName(response.headers, kind, format, filters),
		};
	},
};
