import {
	Bar,
	BarChart,
	CartesianGrid,
	LabelList,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { ticketCategoryLabel } from "@/shared/utils/labels";
import type { DashboardCategoryCount, DashboardPeriod } from "../types";
import {
	AXIS_TICK,
	CATEGORY_TICK,
	CHART_COLORS,
	GRID_STROKE,
	TOOLTIP_CONTENT_STYLE,
	TOOLTIP_CURSOR_FILL,
	TOOLTIP_ITEM_STYLE,
	TOOLTIP_LABEL_STYLE,
} from "../utils/chartTheme";
import { PERIOD_PHRASES } from "../utils/format";
import { ChartCard } from "./ChartCard";

interface CallCategoriesChartProps {
	data: DashboardCategoryCount[];
	period: DashboardPeriod;
	isLoading: boolean;
	isFetching: boolean;
}

const UNCATEGORISED_LABEL = "Kategoriyasiz";
const ROW_HEIGHT = 40;
const MIN_PLOT_HEIGHT = 200;

export function CallCategoriesChart({
	data,
	period,
	isLoading,
	isFetching,
}: CallCategoriesChartProps) {
	// Bitta qator — bitta rang. Uzunlikni rang bilan ikkinchi marta kodlash
	// (katta ustun to'qroq) kategoriyalarga sun'iy tartib qo'shadi.
	const rows = data.map((item) => ({
		label: item.category ? ticketCategoryLabel(item.category) : UNCATEGORISED_LABEL,
		count: item.count,
	}));
	const plotHeight = Math.max(MIN_PLOT_HEIGHT, rows.length * ROW_HEIGHT);

	return (
		<ChartCard
			title="Murojaat turkumlari"
			subtitle={`Murojaatlar bo'yicha taqsimot (${PERIOD_PHRASES[period]})`}
			isLoading={isLoading}
			isFetching={isFetching}
			isEmpty={rows.length === 0}
			emptyTitle="Bu davrda murojaat yaratilmagan"
			emptyHint="Turkum murojaat yaratilganda belgilanadi"
			bodyMinHeight={280}
		>
			<div style={{ height: plotHeight }} className="w-full">
				<ResponsiveContainer width="100%" height="100%">
					<BarChart
						data={rows}
						layout="vertical"
						margin={{ top: 0, right: 44, left: 8, bottom: 8 }}
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
							dataKey="label"
							type="category"
							axisLine={false}
							tickLine={false}
							tick={CATEGORY_TICK}
							width={120}
						/>
						<Tooltip
							cursor={TOOLTIP_CURSOR_FILL}
							contentStyle={TOOLTIP_CONTENT_STYLE}
							labelStyle={TOOLTIP_LABEL_STYLE}
							itemStyle={TOOLTIP_ITEM_STYLE}
						/>
						<Bar
							dataKey="count"
							name="Murojaatlar"
							fill={CHART_COLORS.series}
							radius={[0, 4, 4, 0]}
							barSize={18}
						>
							<LabelList
								dataKey="count"
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
