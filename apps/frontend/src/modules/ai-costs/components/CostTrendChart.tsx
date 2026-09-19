import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartCard, LegendDot } from "@/modules/dashboard/components/ChartCard";
import {
	AXIS_TICK,
	CHART_COLORS,
	GRID_STROKE,
	TOOLTIP_CONTENT_STYLE,
	TOOLTIP_CURSOR_FILL,
	TOOLTIP_ITEM_STYLE,
	TOOLTIP_LABEL_STYLE,
} from "@/modules/dashboard/utils/chartTheme";
import type { CostSeriesPoint, GroupBy } from "../types";
import { formatBucketLabel, formatUsd, GROUP_BY_LABELS } from "../utils/format";

interface Props {
	series: CostSeriesPoint[];
	groupBy: GroupBy;
	isLoading: boolean;
	isFetching: boolean;
}

interface Datum {
	label: string;
	sessions: number;
	/** False when nothing in this bucket could be priced - see the tooltip. */
	costKnown: boolean;
	voice: number;
	transcription: number;
	analysis: number;
}

/** dataKey -> the Uzbek the legend and tooltip show. */
const SERIES: { key: "voice" | "transcription" | "analysis"; label: string; color: string }[] = [
	{ key: "voice", label: "Ovoz", color: CHART_COLORS.series },
	{ key: "transcription", label: "Transkripsiya", color: CHART_COLORS.positive },
	{ key: "analysis", label: "Tahlil", color: CHART_COLORS.neutral },
];

/**
 * A bar can only be as tall as the money we know about, so an unpriced bucket
 * draws at zero height - pixel-identical to a period that genuinely cost nothing.
 * The chart cannot distinguish them, so the tooltip has to: it always names the
 * session count, and says outright when the cost was not computed rather than
 * printing $0.00 at it.
 */
function CostTooltip({ active, payload }: { active?: boolean; payload?: { payload: Datum }[] }) {
	const datum = payload?.[0]?.payload;

	if (active !== true || datum === undefined) {
		return null;
	}

	return (
		<div style={TOOLTIP_CONTENT_STYLE}>
			<div style={TOOLTIP_LABEL_STYLE}>{datum.label}</div>
			<div className="mt-1 text-[11px] font-medium text-slate-400">{datum.sessions} ta sessiya</div>
			{datum.costKnown ? (
				<div className="mt-2 space-y-0.5">
					{SERIES.map((line) => (
						<div key={line.key} style={TOOLTIP_ITEM_STYLE}>
							{line.label}: {formatUsd(datum[line.key])}
						</div>
					))}
				</div>
			) : (
				<div className="mt-2 text-[11px] font-bold italic text-slate-400">narxi hisoblanmagan</div>
			)}
		</div>
	);
}

/**
 * The three cost centres stacked, so which one dominates is legible at a glance
 * without reading a single number - that is the whole point of stacking them
 * rather than drawing three lines.
 */
export function CostTrendChart({ series, groupBy, isLoading, isFetching }: Props) {
	const data: Datum[] = series.map((point) => ({
		label: formatBucketLabel(point.bucket, groupBy),
		sessions: point.sessions,
		costKnown: point.costUsd !== null,
		voice: point.voiceCostUsd ?? 0,
		transcription: point.transcriptionCostUsd ?? 0,
		analysis: point.analysisCostUsd ?? 0,
	}));

	const hasCost = series.some((point) => point.costUsd !== null && point.costUsd > 0);

	return (
		<ChartCard
			title="Xarajat dinamikasi"
			subtitle={`${GROUP_BY_LABELS[groupBy]} kesimda — uchta xarajat markazi bo'yicha`}
			legend={SERIES.map((line) => (
				<LegendDot key={line.key} color={line.color} label={line.label} />
			))}
			isLoading={isLoading}
			isFetching={isFetching}
			isEmpty={!hasCost}
			emptyTitle="Narxi hisoblangan sessiya yo'q"
			emptyHint="Yangi qo'ng'iroqlar to'liq token taqsimotini yozadi va shu yerda paydo bo'ladi"
			bodyMinHeight={340}
		>
			<div className="h-[300px] w-full">
				<ResponsiveContainer width="100%" height="100%">
					<BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
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
						<YAxis
							axisLine={false}
							tickLine={false}
							tick={AXIS_TICK}
							tickFormatter={(value: number) => formatUsd(value)}
							width={70}
						/>
						<Tooltip cursor={TOOLTIP_CURSOR_FILL} content={<CostTooltip />} />
						{SERIES.map((line, index) => (
							<Bar
								key={line.key}
								dataKey={line.key}
								name={line.label}
								stackId="cost"
								fill={line.color}
								// Only the top segment of the stack is rounded.
								radius={index === SERIES.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]}
							/>
						))}
					</BarChart>
				</ResponsiveContainer>
			</div>
		</ChartCard>
	);
}
