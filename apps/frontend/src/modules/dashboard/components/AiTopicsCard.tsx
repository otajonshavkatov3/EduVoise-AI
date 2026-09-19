import { Card, Empty, Spin } from "antd";
import type { DashboardCategoryCount, DashboardPeriod } from "../types";
import { refetchOpacity } from "../utils/chartTheme";
import { PERIOD_PHRASES, shareOf } from "../utils/format";

interface AiTopicsCardProps {
	data: DashboardCategoryCount[];
	period: DashboardPeriod;
	isLoading: boolean;
	isFetching: boolean;
}

/**
 * aiAnalyses.categories — AI suhbatdan aniqlagan mavzular. Chipta
 * kategoriyalaridan alohida ko'rsatiladi, chunki manbasi boshqa: birini odam
 * qo'yadi, ikkinchisini model.
 */
export function AiTopicsCard({ data, period, isLoading, isFetching }: AiTopicsCardProps) {
	const totalMentions = data.reduce((sum, item) => sum + item.count, 0);

	return (
		<Card
			className="h-full border-slate-100 shadow-sm"
			styles={{ body: { padding: 24 } }}
			title={
				<div className="flex flex-col gap-1 py-4">
					<span className="text-lg font-extrabold tracking-tight text-slate-900">
						AI aniqlagan mavzular
					</span>
					<span className="text-xs font-medium text-slate-500">
						Suhbat tahlilidan olingan teglar ({PERIOD_PHRASES[period]})
					</span>
				</div>
			}
		>
			{isLoading && (
				<div className="flex min-h-[200px] items-center justify-center" aria-busy="true">
					<Spin size="large" />
				</div>
			)}

			{!isLoading && data.length === 0 && (
				<div className="flex min-h-[200px] items-center justify-center">
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description={
							<div className="text-center">
								<div className="font-bold text-slate-500">Mavzu aniqlanmagan</div>
								<div className="mt-1 text-xs text-slate-400">
									AI tahlili tugagach mavzular shu yerda paydo bo'ladi
								</div>
							</div>
						}
					/>
				</div>
			)}

			{!isLoading && data.length > 0 && (
				<ul className={`space-y-3 ${refetchOpacity(isFetching)}`}>
					{data.map((item) => (
						<li key={item.category ?? "—"} className="flex items-center gap-3">
							<span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">
								{item.category}
							</span>
							<span className="text-xs font-bold tabular-nums text-slate-900">{item.count}</span>
							<span className="w-10 text-right text-[10px] font-medium text-slate-400">
								{shareOf(item.count, totalMentions)}
							</span>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
