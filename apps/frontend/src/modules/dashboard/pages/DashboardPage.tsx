import { ReloadOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { AiTopicsCard } from "../components/AiTopicsCard";
import { CallCategoriesChart } from "../components/CallCategoriesChart";
import { CallVolumeChart } from "../components/CallVolumeChart";
import { DashboardKpiRow } from "../components/DashboardKpiRow";
import { DashboardNotices } from "../components/DashboardNotices";
import { MissedCallsTable } from "../components/MissedCallsTable";
import { OperatorPerformanceChart } from "../components/OperatorPerformanceChart";
import { OperatorStatusPanel } from "../components/OperatorStatusPanel";
import { PeriodSwitcher } from "../components/PeriodSwitcher";
import { SentimentChart } from "../components/SentimentChart";
import {
	useDashboardCallVolume,
	useDashboardMissedCalls,
	useDashboardOverview,
} from "../hooks/useDashboard";
import type { DashboardPeriod, DashboardSentiment } from "../types";

const MISSED_CALLS_LIMIT = 10;

/** Tahlil hali yo'q holat — barcha sonlar 0, "analyzed 0" bo'sh holatni ochadi. */
const EMPTY_SENTIMENT: DashboardSentiment = {
	positive: 0,
	neutral: 0,
	negative: 0,
	analyzed: 0,
};

export default function DashboardPage() {
	const [period, setPeriod] = useState<DashboardPeriod>("day");

	const overviewQuery = useDashboardOverview(period);
	const volumeQuery = useDashboardCallVolume(period);
	const missedQuery = useDashboardMissedCalls(period, MISSED_CALLS_LIMIT);

	const overview = overviewQuery.data;
	const isRefreshing = overviewQuery.isFetching || volumeQuery.isFetching || missedQuery.isFetching;

	const errorMessage = overviewQuery.isError
		? getApiErrorMessage(overviewQuery.error, "Dashboard ma'lumotlarini yuklab bo'lmadi")
		: null;

	const refetchAll = () => {
		overviewQuery.refetch();
		volumeQuery.refetch();
		missedQuery.refetch();
	};

	return (
		<div className="animate-fadeIn">
			{/* Sahifa sarlavhasi */}
			<div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-center">
				<div>
					<h1 className="text-3xl font-black tracking-tight text-slate-900">Boshqaruv paneli</h1>
					<p className="font-medium text-slate-500">
						Qo'ng'iroq markazi ko'rsatkichlari — barchasi haqiqiy qo'ng'iroq yozuvlaridan
						hisoblanadi
					</p>
				</div>
				<Button
					icon={<ReloadOutlined />}
					loading={isRefreshing}
					onClick={refetchAll}
					className="h-11 rounded-xl font-bold"
				>
					Yangilash
				</Button>
			</div>

			{/* Yagona filtr: barcha kartochka va diagrammalar shu davrga bo'ysunadi */}
			<PeriodSwitcher value={period} onChange={setPeriod} />

			<DashboardNotices scope={overview?.scope} errorMessage={errorMessage} onRetry={refetchAll} />

			<DashboardKpiRow overview={overview} period={period} isLoading={overviewQuery.isLoading} />

			<div className="mb-6">
				<CallVolumeChart
					data={volumeQuery.data}
					period={period}
					isLoading={volumeQuery.isLoading}
					isFetching={volumeQuery.isFetching}
				/>
			</div>

			<div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
				<SentimentChart
					data={overview?.sentiment ?? EMPTY_SENTIMENT}
					period={period}
					isLoading={overviewQuery.isLoading}
					isFetching={overviewQuery.isFetching}
				/>
				<CallCategoriesChart
					data={overview?.ticketCategories ?? []}
					period={period}
					isLoading={overviewQuery.isLoading}
					isFetching={overviewQuery.isFetching}
				/>
				<OperatorStatusPanel
					data={overview?.operators}
					isLoading={overviewQuery.isLoading}
					isFetching={overviewQuery.isFetching}
				/>
			</div>

			<div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
				<div className="lg:col-span-2">
					<OperatorPerformanceChart
						rows={overview?.operatorWorkload ?? []}
						period={period}
						isLoading={overviewQuery.isLoading}
						isFetching={overviewQuery.isFetching}
					/>
				</div>
				<AiTopicsCard
					data={overview?.aiCategories ?? []}
					period={period}
					isLoading={overviewQuery.isLoading}
					isFetching={overviewQuery.isFetching}
				/>
			</div>

			<MissedCallsTable
				items={missedQuery.data?.items ?? []}
				total={missedQuery.data?.total ?? 0}
				period={period}
				isLoading={missedQuery.isLoading}
				isFetching={missedQuery.isFetching}
			/>
		</div>
	);
}
