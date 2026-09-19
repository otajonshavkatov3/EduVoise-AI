import { BarChartOutlined } from "@ant-design/icons";
import { Alert, App, Button, Tabs } from "antd";
import dayjs from "dayjs";
import { type ReactNode, useState } from "react";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { CallsReportTable } from "../components/CallsReportTable";
import { ExportButtons } from "../components/ExportButtons";
import { OperatorsReportTable } from "../components/OperatorsReportTable";
import {
	MAX_RANGE_DAYS,
	ReportFilters,
	type ReportFilterValues,
} from "../components/ReportFilters";
import {
	CallsSummaryTiles,
	OperatorsSummaryTiles,
	TicketsSummaryTiles,
} from "../components/ReportSummaryTiles";
import { ReportsAccessDenied } from "../components/ReportsAccessDenied";
import { TicketsReportTable } from "../components/TicketsReportTable";
import {
	useCallsReport,
	useOperatorsReport,
	useReportExport,
	useTicketsReport,
} from "../hooks/useReports";
import { readExportError } from "../services/report.service";
import type {
	AnyReportFilters,
	CallStatus,
	ExportedFile,
	ExportFormat,
	ReportKind,
	TicketPriority,
	TicketStatus,
} from "../types";
import { formatDate } from "../utils/format";

const TABS: { key: ReportKind; label: string }[] = [
	{ key: "calls", label: "Qo'ng'iroqlar" },
	{ key: "tickets", label: "Murojaatlar" },
	{ key: "operators", label: "Operatorlar" },
];

const DEFAULT_LIMIT = 20;

/** Standart oraliq — joriy oy (TZ 3.7: sana bo'yicha filter). */
function initialFilters(): ReportFilterValues {
	return {
		from: dayjs().startOf("month").toISOString(),
		to: dayjs().endOf("month").toISOString(),
	};
}

function triggerDownload(file: ExportedFile): void {
	const url = window.URL.createObjectURL(file.blob);
	const link = document.createElement("a");

	link.href = url;
	link.download = file.fileName;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	window.URL.revokeObjectURL(url);
}

export default function ReportsPage() {
	const { message } = App.useApp();
	const user = useAuthStore((state) => state.user);
	const canViewReports = user?.role === "admin" || user?.role === "supervisor";

	const [kind, setKind] = useState<ReportKind>("calls");
	const [filters, setFilters] = useState<ReportFilterValues>(initialFilters);
	const [page, setPage] = useState(1);
	const [limit, setLimit] = useState(DEFAULT_LIMIT);
	const [pendingFormat, setPendingFormat] = useState<ExportFormat | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);

	const shared = {
		from: filters.from,
		to: filters.to,
		page,
		limit,
		operatorId: filters.operatorId,
	};
	const callsFilters = {
		...shared,
		status: filters.status as CallStatus | undefined,
		direction: filters.direction,
	};
	const ticketsFilters = {
		...shared,
		status: filters.status as TicketStatus | undefined,
		priority: filters.priority as TicketPriority | undefined,
		category: filters.category,
	};
	const operatorsFilters = { ...shared, direction: filters.direction };

	const callsQuery = useCallsReport(callsFilters, canViewReports && kind === "calls");
	const ticketsQuery = useTicketsReport(ticketsFilters, canViewReports && kind === "tickets");
	const operatorsQuery = useOperatorsReport(
		operatorsFilters,
		canViewReports && kind === "operators"
	);
	const exportMutation = useReportExport();

	const activeQuery = { calls: callsQuery, tickets: ticketsQuery, operators: operatorsQuery }[kind];
	const exportFilters: Record<ReportKind, AnyReportFilters> = {
		calls: callsFilters,
		tickets: ticketsFilters,
		operators: operatorsFilters,
	};

	const summaryTiles: Record<ReportKind, ReactNode> = {
		calls: callsQuery.data ? <CallsSummaryTiles summary={callsQuery.data.data.summary} /> : null,
		tickets: ticketsQuery.data ? (
			<TicketsSummaryTiles summary={ticketsQuery.data.data.summary} />
		) : null,
		operators: operatorsQuery.data ? (
			<OperatorsSummaryTiles summary={operatorsQuery.data.data.summary} />
		) : null,
	};

	const handlePageChange = (nextPage: number, nextLimit: number) => {
		setPage(nextPage);
		setLimit(nextLimit);
	};

	const tables: Record<ReportKind, ReactNode> = {
		calls: (
			<CallsReportTable
				rows={callsQuery.data?.data.items ?? []}
				summary={callsQuery.data?.data.summary}
				meta={callsQuery.data?.data.meta}
				isLoading={callsQuery.isLoading}
				onPageChange={handlePageChange}
			/>
		),
		tickets: (
			<TicketsReportTable
				rows={ticketsQuery.data?.data.items ?? []}
				summary={ticketsQuery.data?.data.summary}
				meta={ticketsQuery.data?.data.meta}
				isLoading={ticketsQuery.isLoading}
				onPageChange={handlePageChange}
			/>
		),
		operators: (
			<OperatorsReportTable
				rows={operatorsQuery.data?.data.items ?? []}
				summary={operatorsQuery.data?.data.summary}
				meta={operatorsQuery.data?.data.meta}
				isLoading={operatorsQuery.isLoading}
				onPageChange={handlePageChange}
			/>
		),
	};

	const handleFiltersChange = (patch: Partial<ReportFilterValues>) => {
		setFilters((current) => ({ ...current, ...patch }));
		setPage(1);
	};

	/** Tab almashganda status/prioritet/kategoriya boshqa enum'ga tegishli bo'lib qoladi. */
	const handleTabChange = (nextKind: ReportKind) => {
		setKind(nextKind);
		setPage(1);
		setExportError(null);
		setFilters((current) => ({
			from: current.from,
			to: current.to,
			operatorId: current.operatorId,
			direction: nextKind === "tickets" ? undefined : current.direction,
		}));
	};

	const handleReset = () => {
		setFilters(initialFilters());
		setPage(1);
		setExportError(null);
	};

	const handleExport = async (format: ExportFormat) => {
		setPendingFormat(format);
		setExportError(null);

		try {
			const file = await exportMutation.mutateAsync({
				kind,
				filters: exportFilters[kind],
				format,
			});

			triggerDownload(file);
			message.success(`${file.fileName} yuklab olindi`);
		} catch (error) {
			// Blob rejimida xato JSON bo'lib keladi — matnini o'qib ko'rsatamiz.
			const text = await readExportError(error, "Faylni yuklab bo'lmadi");

			setExportError(text);
			message.error(text);
		} finally {
			setPendingFormat(null);
		}
	};

	if (!canViewReports) {
		return <ReportsAccessDenied />;
	}

	return (
		<div className="animate-fadeIn">
			{/* Sahifa sarlavhasi */}
			<div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-center">
				<div>
					<h1 className="flex items-center gap-3 text-3xl font-black tracking-tight text-slate-900">
						<BarChartOutlined className="text-blue-600" />
						Hisobotlar
					</h1>
					<p className="font-medium text-slate-500">
						{formatDate(filters.from)} — {formatDate(filters.to)} · ko'rsatkichlar tanlangan
						oraliqdagi haqiqiy yozuvlardan hisoblanadi
					</p>
				</div>

				<ExportButtons
					pendingFormat={pendingFormat}
					disabled={activeQuery.isLoading || activeQuery.isError}
					onExport={handleExport}
					rowCount={activeQuery.data?.data.meta.total}
				/>
			</div>

			<Tabs
				activeKey={kind}
				onChange={(key) => handleTabChange(key as ReportKind)}
				className="custom-segmented-tabs"
				items={TABS.map((tab) => ({ key: tab.key, label: tab.label }))}
			/>

			<ReportFilters
				kind={kind}
				values={filters}
				onChange={handleFiltersChange}
				onReset={handleReset}
				onRefresh={() => activeQuery.refetch()}
				isFetching={activeQuery.isFetching}
				onRangeRejected={(days) =>
					message.warning(
						`Oraliq ${days} kun — hisobot uchun eng ko'pi ${MAX_RANGE_DAYS} kun. Oraliqni toraytiring.`
					)
				}
			/>

			{exportError && (
				<Alert
					type="error"
					showIcon
					closable
					className="mb-6 rounded-2xl"
					message="Faylni yuklab bo'lmadi"
					description={exportError}
					onClose={() => setExportError(null)}
				/>
			)}

			{activeQuery.isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Hisobotni yuklab bo'lmadi"
					description={getApiErrorMessage(activeQuery.error, "Server bilan aloqa yo'q")}
					action={
						<Button size="small" onClick={() => activeQuery.refetch()}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			{summaryTiles[kind]}
			{tables[kind]}
		</div>
	);
}
