import { DollarOutlined } from "@ant-design/icons";
import { Alert, App, Button, Segmented } from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { AiCostsAccessDenied } from "../components/AiCostsAccessDenied";
import { CostFilters, type CostFilterValues, MAX_RANGE_DAYS } from "../components/CostFilters";
import { CostSummaryTiles } from "../components/CostSummaryTiles";
import { CostTrendChart } from "../components/CostTrendChart";
import { EstimateNotesCard } from "../components/EstimateNotesCard";
import { ExpensiveCallsTable } from "../components/ExpensiveCallsTable";
import { PricingNotice } from "../components/PricingNotice";
import { ProviderSplitTable } from "../components/ProviderSplitTable";
import { RatesCard } from "../components/RatesCard";
import { TokenBreakdownCard } from "../components/TokenBreakdownCard";
import { useAiCostCalls, useAiCostRates, useAiCostSummary } from "../hooks/useAiCosts";
import type { CostSort } from "../types";
import { formatDate } from "../utils/format";

const DEFAULT_LIMIT = 20;

const SORT_OPTIONS: { value: CostSort; label: string }[] = [
	{ value: "cost", label: "Eng qimmat" },
	{ value: "duration", label: "Eng uzun" },
	{ value: "startedAt", label: "Eng yangi" },
];

/**
 * The zone the day boundary was cut in, but only when the viewer is not in it.
 *
 * The backend buckets in general.timezone; a viewer sitting elsewhere would
 * otherwise see a call booked to what looks like the wrong day with nothing on
 * screen to explain it. For everyone else the label is noise.
 */
function zoneToAnnounce(summaryZone: string | undefined): string | null {
	if (summaryZone === undefined) {
		return null;
	}

	return summaryZone === Intl.DateTimeFormat().resolvedOptions().timeZone ? null : summaryZone;
}

/** Standart oraliq — joriy oy, Hisobotlar sahifasidagi kabi. */
function initialFilters(): CostFilterValues {
	return {
		from: dayjs().startOf("month").toISOString(),
		to: dayjs().endOf("month").toISOString(),
		groupBy: "day",
	};
}

export default function AiCostsPage() {
	const { message } = App.useApp();
	const user = useAuthStore((state) => state.user);
	const canView = user?.role === "admin" || user?.role === "supervisor";

	const [filters, setFilters] = useState<CostFilterValues>(initialFilters);
	const [sort, setSort] = useState<CostSort>("cost");
	const [page, setPage] = useState(1);
	const [limit, setLimit] = useState(DEFAULT_LIMIT);

	const summaryQuery = useAiCostSummary(
		{ from: filters.from, to: filters.to, groupBy: filters.groupBy },
		canView
	);
	const callsQuery = useAiCostCalls(
		{
			from: filters.from,
			to: filters.to,
			provider: filters.provider,
			sort,
			page,
			limit,
		},
		canView
	);
	const ratesQuery = useAiCostRates({ from: filters.from, to: filters.to }, canView);

	const summary = summaryQuery.data?.data;
	// The provider filter's options come from the data rather than a hardcoded
	// list, so a third backend appears here the day it answers its first call.
	const providers = Array.from(new Set((summary?.byProvider ?? []).map((row) => row.provider)));
	const foreignZone = zoneToAnnounce(summary?.range.timeZone);

	const handleFiltersChange = (patch: Partial<CostFilterValues>) => {
		setFilters((current) => ({ ...current, ...patch }));
		setPage(1);
	};

	const handleReset = () => {
		setFilters(initialFilters());
		setSort("cost");
		setPage(1);
	};

	const handleRefresh = () => {
		summaryQuery.refetch();
		callsQuery.refetch();
		ratesQuery.refetch();
	};

	const handlePageChange = (nextPage: number, nextLimit: number) => {
		setPage(nextPage);
		setLimit(nextLimit);
	};

	if (!canView) {
		return <AiCostsAccessDenied />;
	}

	return (
		<div className="animate-fadeIn">
			{/* Sahifa sarlavhasi */}
			<div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-center">
				<div>
					<h1 className="flex items-center gap-3 text-3xl font-black tracking-tight text-slate-900">
						<DollarOutlined className="text-blue-600" />
						AI xarajatlari
					</h1>
					<p className="font-medium text-slate-500">
						{formatDate(filters.from)} — {formatDate(filters.to)}
						{/* The bars are cut in the organisation's zone, not the browser's. Naming
						    it only when they differ keeps the common case quiet while making a
						    day boundary that looks "wrong" explicable. */}
						{foreignZone && <> · {foreignZone} bo'yicha</>} · har safar joriy tariflar bo'yicha
						qayta hisoblanadi
					</p>
				</div>
			</div>

			<CostFilters
				values={filters}
				providers={providers}
				onChange={handleFiltersChange}
				onReset={handleReset}
				onRefresh={handleRefresh}
				isFetching={summaryQuery.isFetching || callsQuery.isFetching}
				onRangeRejected={(days) =>
					message.warning(
						`Oraliq ${days} kun — eng ko'pi ${MAX_RANGE_DAYS} kun. Oraliqni toraytiring.`
					)
				}
			/>

			{summaryQuery.isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Xarajat ma'lumotini yuklab bo'lmadi"
					description={getApiErrorMessage(summaryQuery.error, "Server bilan aloqa yo'q")}
					action={
						<Button size="small" onClick={() => summaryQuery.refetch()}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			{summary && <PricingNotice pricing={summary.pricing} />}
			{summary && <CostSummaryTiles totals={summary.totals} />}

			<div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
				<CostTrendChart
					series={summary?.series ?? []}
					groupBy={filters.groupBy}
					isLoading={summaryQuery.isLoading}
					isFetching={summaryQuery.isFetching}
				/>
				{summary && <TokenBreakdownCard voice={summary.totals.voice} />}
			</div>

			<div className="mb-6">
				<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
					<div>
						<h3 className="text-lg font-extrabold tracking-tight text-slate-900">
							Qo'ng'iroqlar bo'yicha
						</h3>
						<p className="text-xs font-medium text-slate-500">
							Narx yonidagi ustunlar nima uchun shuncha turganini ko'rsatadi: davomiyligi, javoblar
							soni, kesh ulushi va chiquvchi audio
						</p>
					</div>
					<Segmented<CostSort>
						value={sort}
						options={SORT_OPTIONS}
						onChange={(value) => {
							setSort(value);
							setPage(1);
						}}
					/>
				</div>
				<ExpensiveCallsTable
					rows={callsQuery.data?.data.items ?? []}
					meta={callsQuery.data?.data.meta}
					isLoading={callsQuery.isLoading}
					onPageChange={handlePageChange}
				/>
			</div>

			<div className="mb-6">
				<ProviderSplitTable rows={summary?.byProvider ?? []} isLoading={summaryQuery.isLoading} />
			</div>

			<div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
				<RatesCard
					items={ratesQuery.data?.data.items ?? []}
					observedModels={ratesQuery.data?.data.observedModels ?? []}
					isLoading={ratesQuery.isLoading}
				/>
				<EstimateNotesCard notes={summary?.estimateNotes ?? []} />
			</div>
		</div>
	);
}
