import { Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { OperatorReportRow, OperatorsSummary, PaginationMeta } from "../types";
import {
	formatDuration,
	formatPercent,
	formatReportPhone,
	OPERATOR_STATUS_COLORS,
	OPERATOR_STATUS_LABELS,
} from "../utils/format";
import { buildEmptyLocale, buildPagination, ReportCard } from "./ReportTableShell";

const { Text } = Typography;

interface Props {
	rows: OperatorReportRow[];
	summary?: OperatorsSummary;
	meta?: PaginationMeta;
	isLoading: boolean;
	onPageChange: (page: number, limit: number) => void;
}

/** null qiymat — hisoblash uchun namuna bo'lmagan, 0 bilan almashtirilmaydi. */
function NumberCell({ value }: { value: number | null }) {
	if (value === null) {
		return <Text className="text-[11px] italic text-slate-400">—</Text>;
	}

	return <span className="text-xs font-bold tabular-nums text-slate-700">{value}</span>;
}

const columns: ColumnsType<OperatorReportRow> = [
	{
		title: "Operator",
		key: "operator",
		width: 200,
		fixed: "left",
		render: (_, row) => (
			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-2">
					<span className="font-bold text-slate-900">{row.extension}</span>
					{row.isDeleted && (
						<Tooltip title="Profil o'chirilgan, lekin oraliqda faoliyati bo'lgan">
							<Tag color="red" className="rounded-md text-[10px]">
								o'chirilgan
							</Tag>
						</Tooltip>
					)}
				</div>
				<span className="text-[11px] font-medium text-slate-500">
					{row.username ?? formatReportPhone(row.userPhone)}
				</span>
			</div>
		),
	},
	{
		title: "Holat",
		key: "currentStatus",
		width: 120,
		render: (_, row) => (
			<Tag color={OPERATOR_STATUS_COLORS[row.currentStatus]} className="rounded-md font-bold">
				{OPERATOR_STATUS_LABELS[row.currentStatus]}
			</Tag>
		),
	},
	{
		title: "Jami",
		key: "totalCalls",
		width: 90,
		align: "right",
		render: (_, row) => (
			<span className="text-sm font-black tabular-nums text-slate-900">{row.totalCalls}</span>
		),
	},
	{
		title: "Kiruvchi",
		key: "inboundCalls",
		width: 100,
		align: "right",
		render: (_, row) => <NumberCell value={row.inboundCalls} />,
	},
	{
		title: "Chiquvchi",
		key: "outboundCalls",
		width: 100,
		align: "right",
		render: (_, row) => <NumberCell value={row.outboundCalls} />,
	},
	{
		title: "Javob berilgan",
		key: "answeredCalls",
		width: 130,
		align: "right",
		render: (_, row) => <NumberCell value={row.answeredCalls} />,
	},
	{
		title: "O'tkazib yub.",
		key: "missedCalls",
		width: 120,
		align: "right",
		render: (_, row) =>
			row.missedCalls > 0 ? (
				<span className="text-xs font-bold tabular-nums text-rose-500">{row.missedCalls}</span>
			) : (
				<NumberCell value={row.missedCalls} />
			),
	},
	{
		title: "Tashlab ketilgan",
		key: "abandonedCalls",
		width: 140,
		align: "right",
		render: (_, row) => <NumberCell value={row.abandonedCalls} />,
	},
	{
		title: "Javob berish",
		key: "answeredRate",
		width: 120,
		align: "right",
		render: (_, row) =>
			row.answeredRate === null ? (
				<Text className="text-[11px] italic text-slate-400">—</Text>
			) : (
				<span className="text-xs font-bold tabular-nums text-slate-700">
					{formatPercent(row.answeredRate)}
				</span>
			),
	},
	{
		title: "O'rtacha suhbat",
		key: "avgTalkSeconds",
		width: 140,
		align: "right",
		render: (_, row) =>
			row.avgTalkSeconds === null ? (
				<Text className="text-[11px] italic text-slate-400">—</Text>
			) : (
				<Tooltip title={`${row.talkSampleCount} javob berilgan qo'ng'iroq asosida`}>
					<span className="text-xs font-bold tabular-nums text-slate-700">
						{formatDuration(row.avgTalkSeconds)}
					</span>
				</Tooltip>
			),
	},
	{
		title: "Jami suhbat",
		key: "totalTalkSeconds",
		width: 130,
		align: "right",
		render: (_, row) => (
			<span className="text-xs font-bold tabular-nums text-slate-700">
				{formatDuration(row.totalTalkSeconds)}
			</span>
		),
	},
	{
		title: "O'rtacha kutish",
		key: "avgWaitSeconds",
		width: 140,
		align: "right",
		render: (_, row) =>
			row.avgWaitSeconds === null ? (
				<Tooltip title="Javob berilgan vaqt yozilgan qo'ng'iroq yo'q">
					<Text className="text-[11px] italic text-slate-400">ma'lumot yo'q</Text>
				</Tooltip>
			) : (
				<Tooltip title={`${row.waitSampleCount} qo'ng'iroq asosida`}>
					<span className="text-xs font-bold tabular-nums text-slate-700">
						{formatDuration(row.avgWaitSeconds)}
					</span>
				</Tooltip>
			),
	},
	{
		title: "Murojaat",
		key: "ticketsCreated",
		width: 110,
		align: "right",
		render: (_, row) => <NumberCell value={row.ticketsCreated} />,
	},
];

export function OperatorsReportTable({ rows, summary, meta, isLoading, onPageChange }: Props) {
	return (
		<ReportCard>
			<Table<OperatorReportRow>
				columns={columns}
				dataSource={rows}
				loading={isLoading}
				rowKey="operatorId"
				size="middle"
				scroll={{ x: 1700 }}
				rowClassName={(row) => (row.isDeleted ? "bg-rose-50/40" : "")}
				pagination={buildPagination(meta, onPageChange)}
				locale={buildEmptyLocale("Tanlangan oraliqda operator faoliyati topilmadi")}
				summary={() =>
					rows.length === 0 || !summary ? null : (
						<Table.Summary fixed>
							<Table.Summary.Row className="bg-slate-50">
								<Table.Summary.Cell index={0}>
									<span className="text-xs font-black text-slate-900">
										JAMI — {summary.operatorCount} operator
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={1} />
								<Table.Summary.Cell index={2} align="right">
									<span className="text-sm font-black tabular-nums text-slate-900">
										{summary.totalCalls}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={3} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{summary.inboundCalls}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={4} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{summary.outboundCalls}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={5} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{summary.answeredCalls}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={6} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{summary.missedCalls}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={7} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{summary.abandonedCalls}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={8} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{formatPercent(summary.answeredRate)}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={9} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{formatDuration(summary.avgTalkSeconds)}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={10} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{formatDuration(summary.totalTalkSeconds)}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={11} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{formatDuration(summary.avgWaitSeconds)}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={12} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{summary.ticketsCreated}
									</span>
								</Table.Summary.Cell>
							</Table.Summary.Row>
						</Table.Summary>
					)
				}
			/>
		</ReportCard>
	);
}
