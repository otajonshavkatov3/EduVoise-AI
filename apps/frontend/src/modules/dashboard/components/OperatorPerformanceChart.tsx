import {
	Bar,
	BarChart,
	CartesianGrid,
	LabelList,
	ResponsiveContainer,
	Tooltip,
	type TooltipContentProps,
	XAxis,
	YAxis,
} from "recharts";
import type { DashboardOperatorWorkload, DashboardPeriod } from "../types";
import {
	AXIS_TICK,
	CATEGORY_TICK,
	CHART_COLORS,
	GRID_STROKE,
	TOOLTIP_CONTENT_STYLE,
	TOOLTIP_CURSOR_FILL,
} from "../utils/chartTheme";
import { formatDuration, PERIOD_PHRASES } from "../utils/format";
import { ChartCard } from "./ChartCard";

interface OperatorPerformanceChartProps {
	rows: DashboardOperatorWorkload[];
	period: DashboardPeriod;
	isLoading: boolean;
	isFetching: boolean;
}

const ROW_HEIGHT = 44;
const MIN_PLOT_HEIGHT = 220;

/**
 * Tooltip qo'shimcha sonlarni ko'rsatadi. Ular alohida o'q sifatida
 * chizilmaydi: qo'ng'iroq soni va muloqot vaqti — turli o'lchov birliklari,
 * bitta o'qqa qo'yilsa grafik yolg'on korrelyatsiya yasaydi.
 */
function WorkloadTooltip({ active, payload }: Partial<TooltipContentProps<number, string>>) {
	if (!(active && payload?.length)) {
		return null;
	}

	const row = payload[0]?.payload as DashboardOperatorWorkload | undefined;

	if (!row) {
		return null;
	}

	return (
		<div style={TOOLTIP_CONTENT_STYLE}>
			<div className="mb-1 text-sm font-bold text-slate-900">{row.name}</div>
			<div className="text-[11px] font-medium text-slate-500">Ichki raqam: {row.extension}</div>
			<div className="mt-2 space-y-0.5 text-xs font-bold text-slate-700">
				<div>Jami qo'ng'iroq: {row.totalCalls}</div>
				<div>Javob berilgan: {row.answeredCalls}</div>
				<div>Javobsiz: {row.missedCalls}</div>
				<div>O'rtacha muloqot: {formatDuration(row.avgTalkTimeSec)}</div>
			</div>
		</div>
	);
}

export function OperatorPerformanceChart({
	rows,
	period,
	isLoading,
	isFetching,
}: OperatorPerformanceChartProps) {
	const plotHeight = Math.max(MIN_PLOT_HEIGHT, rows.length * ROW_HEIGHT);

	return (
		<ChartCard
			title="Operatorlar yuklamasi"
			subtitle={`Har bir operator qabul qilgan qo'ng'iroqlar soni (${PERIOD_PHRASES[period]})`}
			isLoading={isLoading}
			isFetching={isFetching}
			isEmpty={rows.length === 0}
			emptyTitle="Operatorga biriktirilgan qo'ng'iroq yo'q"
			emptyHint="Qo'ng'iroq operatorga uzatilganda u shu yerda ko'rinadi"
			bodyMinHeight={280}
		>
			<div style={{ height: plotHeight }} className="w-full">
				<ResponsiveContainer width="100%" height="100%">
					<BarChart
						data={rows}
						layout="vertical"
						margin={{ top: 0, right: 48, left: 8, bottom: 8 }}
					>
						<CartesianGrid horizontal={false} stroke={GRID_STROKE} />
						<XAxis
							type="number"
							axisLine={false}
							tickLine={false}
							tick={AXIS_TICK}
							allowDecimals={false}
						/>
						<YAxis
							type="category"
							dataKey="name"
							axisLine={false}
							tickLine={false}
							tick={CATEGORY_TICK}
							width={130}
						/>
						<Tooltip cursor={TOOLTIP_CURSOR_FILL} content={<WorkloadTooltip />} />
						<Bar
							dataKey="totalCalls"
							name="Qo'ng'iroqlar"
							fill={CHART_COLORS.series}
							radius={[0, 4, 4, 0]}
							barSize={18}
						>
							<LabelList
								dataKey="totalCalls"
								position="right"
								offset={10}
								className="fill-slate-900"
								style={{ fontSize: 12, fontWeight: 700 }}
							/>
						</Bar>
					</BarChart>
				</ResponsiveContainer>
			</div>
		</ChartCard>
	);
}
