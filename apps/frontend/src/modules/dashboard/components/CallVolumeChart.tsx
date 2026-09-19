import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { DashboardCallVolume, DashboardPeriod } from "../types";
import {
	AXIS_TICK,
	CHART_COLORS,
	GRID_STROKE,
	TOOLTIP_CONTENT_STYLE,
	TOOLTIP_ITEM_STYLE,
	TOOLTIP_LABEL_STYLE,
} from "../utils/chartTheme";
import { EMPTY_CHART_MESSAGES } from "../utils/format";
import { ChartCard, LegendDot } from "./ChartCard";

interface CallVolumeChartProps {
	data?: DashboardCallVolume;
	period: DashboardPeriod;
	isLoading: boolean;
	isFetching: boolean;
}

const SUBTITLES: Record<DashboardPeriod, string> = {
	day: "Bugun soat kesimida — javob berilgan va javobsiz qo'ng'iroqlar",
	week: "Oxirgi 7 kun — javob berilgan va javobsiz qo'ng'iroqlar",
	month: "Oxirgi 30 kun — javob berilgan va javobsiz qo'ng'iroqlar",
};

export function CallVolumeChart({ data, period, isLoading, isFetching }: CallVolumeChartProps) {
	const buckets = data?.buckets ?? [];
	const totalCalls = data?.totalCalls ?? 0;
	const answered = buckets.reduce((sum, bucket) => sum + bucket.answered, 0);
	const unanswered = buckets.reduce((sum, bucket) => sum + bucket.unanswered, 0);

	return (
		<ChartCard
			title="Qo'ng'iroqlar oqimi"
			subtitle={SUBTITLES[period]}
			legend={
				<>
					<LegendDot color={CHART_COLORS.answered} label="Javob berilgan" />
					<LegendDot color={CHART_COLORS.unanswered} label="Javobsiz" />
				</>
			}
			isLoading={isLoading}
			isFetching={isFetching}
			isEmpty={totalCalls === 0}
			emptyTitle={EMPTY_CHART_MESSAGES[period]}
			emptyHint="Qo'ng'iroq kelganda grafik o'zi to'ldiriladi"
			bodyMinHeight={360}
			footer={
				<div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-slate-50 pt-4 text-xs font-medium text-slate-500">
					<span>
						Jami: <span className="font-bold tabular-nums text-slate-900">{totalCalls}</span>
					</span>
					<span>
						Javob berilgan:{" "}
						<span className="font-bold tabular-nums text-slate-900">{answered}</span>
					</span>
					<span>
						Javobsiz: <span className="font-bold tabular-nums text-slate-900">{unanswered}</span>
					</span>
				</div>
			}
		>
			<div className="h-[320px] w-full">
				<ResponsiveContainer width="100%" height="100%">
					<AreaChart data={buckets} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
						<defs>
							<linearGradient id="dashAnsweredFill" x1="0" y1="0" x2="0" y2="1">
								<stop offset="5%" stopColor={CHART_COLORS.answered} stopOpacity={0.14} />
								<stop offset="95%" stopColor={CHART_COLORS.answered} stopOpacity={0} />
							</linearGradient>
							<linearGradient id="dashUnansweredFill" x1="0" y1="0" x2="0" y2="1">
								<stop offset="5%" stopColor={CHART_COLORS.unanswered} stopOpacity={0.14} />
								<stop offset="95%" stopColor={CHART_COLORS.unanswered} stopOpacity={0} />
							</linearGradient>
						</defs>
						<CartesianGrid vertical={false} stroke={GRID_STROKE} />
						<XAxis
							dataKey="label"
							axisLine={false}
							tickLine={false}
							tick={AXIS_TICK}
							dy={10}
							interval="preserveStartEnd"
							minTickGap={16}
						/>
						<YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} />
						<Tooltip
							contentStyle={TOOLTIP_CONTENT_STYLE}
							itemStyle={TOOLTIP_ITEM_STYLE}
							labelStyle={TOOLTIP_LABEL_STYLE}
						/>
						<Area
							// Linear, monotone emas: silliqlangan egri chiziq ustunlar orasida
							// haqiqatda bo'lmagan qiymatlarni chizib ko'rsatadi.
							type="linear"
							dataKey="answered"
							stroke={CHART_COLORS.answered}
							strokeWidth={2}
							fillOpacity={1}
							fill="url(#dashAnsweredFill)"
							name="Javob berilgan"
							activeDot={{ r: 5, strokeWidth: 2, stroke: "#ffffff" }}
						/>
						<Area
							// Linear, monotone emas: silliqlangan egri chiziq ustunlar orasida
							// haqiqatda bo'lmagan qiymatlarni chizib ko'rsatadi.
							type="linear"
							dataKey="unanswered"
							stroke={CHART_COLORS.unanswered}
							strokeWidth={2}
							fillOpacity={1}
							fill="url(#dashUnansweredFill)"
							name="Javobsiz"
							activeDot={{ r: 5, strokeWidth: 2, stroke: "#ffffff" }}
						/>
					</AreaChart>
				</ResponsiveContainer>
			</div>
		</ChartCard>
	);
}
