import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { DashboardPeriod, DashboardSentiment } from "../types";
import { CHART_COLORS, TOOLTIP_CONTENT_STYLE, TOOLTIP_ITEM_STYLE } from "../utils/chartTheme";
import { PERIOD_PHRASES, shareOf } from "../utils/format";
import { ChartCard } from "./ChartCard";

interface SentimentChartProps {
	data: DashboardSentiment;
	period: DashboardPeriod;
	isLoading: boolean;
	isFetching: boolean;
}

/**
 * Kayfiyat — qutbli shkala: ijobiy (yashil) — neytral (kulrang) — salbiy (qizil).
 * Neytral markaz ataylab kulrang: "hech qanday tomonga" degani.
 */
export function SentimentChart({ data, period, isLoading, isFetching }: SentimentChartProps) {
	const slices = [
		{ key: "positive", name: "Ijobiy", value: data.positive, color: CHART_COLORS.positive },
		{ key: "neutral", name: "Neytral", value: data.neutral, color: CHART_COLORS.neutral },
		{ key: "negative", name: "Salbiy", value: data.negative, color: CHART_COLORS.negative },
	];
	const analyzed = data.analyzed;

	return (
		<ChartCard
			title="AI kayfiyat tahlili"
			subtitle={`Tahlil qilingan qo'ng'iroqlar kayfiyati (${PERIOD_PHRASES[period]})`}
			isLoading={isLoading}
			isFetching={isFetching}
			isEmpty={analyzed === 0}
			emptyTitle="AI tahlili hali yo'q"
			emptyHint="Qo'ng'iroq tugagach AI suhbatni tahlil qiladi"
			bodyMinHeight={280}
			footer={
				<div className="mt-4 grid grid-cols-3 gap-2">
					{slices.map((slice) => (
						<div
							key={slice.key}
							className="flex flex-col items-center rounded-xl bg-slate-50/70 p-2"
						>
							<div className="mb-1 flex items-center gap-1.5">
								<span className="h-2 w-2 rounded-full" style={{ backgroundColor: slice.color }} />
								<span className="text-[10px] font-bold uppercase text-slate-500">{slice.name}</span>
							</div>
							<span className="text-sm font-black tabular-nums text-slate-800">{slice.value}</span>
							<span className="text-[10px] font-medium text-slate-400">
								{shareOf(slice.value, analyzed)}
							</span>
						</div>
					))}
				</div>
			}
		>
			<div className="relative h-[240px] w-full">
				<ResponsiveContainer width="100%" height="100%">
					<PieChart>
						<Pie
							data={slices}
							cx="50%"
							cy="50%"
							innerRadius={64}
							outerRadius={92}
							paddingAngle={4}
							dataKey="value"
							nameKey="name"
							stroke="#ffffff"
							strokeWidth={2}
						>
							{slices.map((slice) => (
								<Cell key={slice.key} fill={slice.color} className="outline-none" />
							))}
						</Pie>
						<Tooltip contentStyle={TOOLTIP_CONTENT_STYLE} itemStyle={TOOLTIP_ITEM_STYLE} />
					</PieChart>
				</ResponsiveContainer>

				<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
					<span className="text-2xl font-black text-slate-900">{analyzed}</span>
					<span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
						Tahlil qilingan
					</span>
				</div>
			</div>
		</ChartCard>
	);
}
