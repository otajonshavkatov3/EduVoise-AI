import { Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { CallReportRow, CallsSummary, PaginationMeta } from "../types";
import {
	AI_STATUS_LABELS,
	CALL_DIRECTION_LABELS,
	CALL_STATUS_COLORS,
	CALL_STATUS_LABELS,
	formatDateTime,
	formatDuration,
	formatReportPhone,
} from "../utils/format";
import { buildEmptyLocale, buildPagination, ReportCard } from "./ReportTableShell";

const { Text } = Typography;

interface Props {
	rows: CallReportRow[];
	summary?: CallsSummary;
	meta?: PaginationMeta;
	isLoading: boolean;
	onPageChange: (page: number, limit: number) => void;
}

const columns: ColumnsType<CallReportRow> = [
	{
		title: "Boshlanish",
		key: "startedAt",
		width: 150,
		render: (_, row) => (
			<div className="flex flex-col">
				<span className="text-xs font-bold text-slate-700">{formatDateTime(row.startedAt)}</span>
				<span className="text-[10px] text-slate-400">{CALL_DIRECTION_LABELS[row.direction]}</span>
			</div>
		),
	},
	{
		title: "Holat",
		key: "status",
		width: 150,
		render: (_, row) => (
			<Tag color={CALL_STATUS_COLORS[row.status]} className="rounded-md font-bold">
				{CALL_STATUS_LABELS[row.status]}
			</Tag>
		),
	},
	{
		title: "Mijoz",
		key: "contact",
		width: 200,
		render: (_, row) => (
			<div className="flex flex-col">
				<span className="text-xs font-bold text-slate-700">{row.contactName ?? "Noma'lum"}</span>
				<span className="font-mono text-[10px] text-slate-400">
					{formatReportPhone(row.contactPhone ?? row.callerNumber)}
				</span>
			</div>
		),
	},
	{
		title: "Operator",
		key: "operator",
		width: 170,
		render: (_, row) =>
			row.operatorExtension ? (
				<div className="flex flex-col">
					<span className="text-xs font-bold text-slate-700">{row.operatorExtension}</span>
					<span className="font-mono text-[10px] text-slate-400">
						{formatReportPhone(row.operatorPhone)}
					</span>
				</div>
			) : (
				<Text className="text-xs italic text-slate-400">Biriktirilmagan</Text>
			),
	},
	{
		title: "Kutish",
		key: "waitSeconds",
		width: 110,
		align: "right",
		render: (_, row) =>
			row.waitSeconds === null ? (
				<Text className="text-[11px] italic text-slate-400">yozilmagan</Text>
			) : (
				<span className="text-xs font-bold tabular-nums text-slate-700">
					{formatDuration(row.waitSeconds)}
				</span>
			),
	},
	{
		title: "Davomiyligi",
		key: "durationSeconds",
		width: 120,
		align: "right",
		render: (_, row) => (
			<span className="text-xs font-bold tabular-nums text-slate-700">
				{formatDuration(row.durationSeconds)}
			</span>
		),
	},
	{
		title: "Murojaat",
		key: "ticket",
		width: 240,
		render: (_, row) =>
			row.ticketSubject ? (
				<span className="text-xs font-medium text-slate-600">{row.ticketSubject}</span>
			) : (
				<Text className="text-xs italic text-slate-400">—</Text>
			),
	},
	{
		title: "AI",
		key: "aiStatus",
		width: 120,
		render: (_, row) =>
			row.aiStatus ? (
				<span className="text-[11px] font-bold text-slate-500">
					{AI_STATUS_LABELS[row.aiStatus]}
				</span>
			) : (
				<Text className="text-xs italic text-slate-400">—</Text>
			),
	},
];

export function CallsReportTable({ rows, summary, meta, isLoading, onPageChange }: Props) {
	return (
		<ReportCard>
			<Table<CallReportRow>
				columns={columns}
				dataSource={rows}
				loading={isLoading}
				rowKey="id"
				size="middle"
				scroll={{ x: 1300 }}
				pagination={buildPagination(meta, onPageChange)}
				locale={buildEmptyLocale("Tanlangan oraliqda qo'ng'iroq topilmadi")}
				summary={() =>
					rows.length === 0 || !summary ? null : (
						<Table.Summary fixed>
							<Table.Summary.Row className="bg-slate-50">
								<Table.Summary.Cell index={0}>
									<span className="text-xs font-black text-slate-900">
										JAMI — {summary.totalCalls} qo'ng'iroq
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={1}>
									<span className="text-[11px] font-bold text-slate-500">
										{summary.answeredCalls} javob · {summary.missedCalls} o'tkazib yuborilgan
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={2} />
								<Table.Summary.Cell index={3} />
								<Table.Summary.Cell index={4} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{summary.waitSampleCount > 0 ? formatDuration(summary.totalWaitSeconds) : "—"}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={5} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{formatDuration(summary.totalTalkSeconds)}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={6} />
								<Table.Summary.Cell index={7} />
							</Table.Summary.Row>
						</Table.Summary>
					)
				}
			/>
		</ReportCard>
	);
}
