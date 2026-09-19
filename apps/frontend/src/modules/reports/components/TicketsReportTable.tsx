import { Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ticketCategoryLabel } from "@/shared/utils/labels";
import type { PaginationMeta, TicketReportRow, TicketsSummary } from "../types";
import {
	formatDateTime,
	formatHours,
	formatPercent,
	formatReportPhone,
	SENTIMENT_COLORS,
	SENTIMENT_LABELS,
	TICKET_PRIORITY_COLORS,
	TICKET_PRIORITY_LABELS,
	TICKET_STATUS_COLORS,
	TICKET_STATUS_LABELS,
} from "../utils/format";
import { buildEmptyLocale, buildPagination, ReportCard } from "./ReportTableShell";

const { Text } = Typography;

interface Props {
	rows: TicketReportRow[];
	summary?: TicketsSummary;
	meta?: PaginationMeta;
	isLoading: boolean;
	onPageChange: (page: number, limit: number) => void;
}

const columns: ColumnsType<TicketReportRow> = [
	{
		title: "Murojaat",
		key: "subject",
		width: 280,
		render: (_, row) => (
			<div className="flex flex-col gap-1">
				<span className="font-bold text-slate-900">{row.subject}</span>
				<span className="text-[10px] font-mono uppercase text-slate-400">
					#{row.id.slice(0, 8)}
					{row.externalRefId ? ` · M-Nazorat: ${row.externalRefId}` : ""}
				</span>
			</div>
		),
	},
	{
		title: "Kategoriya",
		key: "category",
		width: 140,
		render: (_, row) =>
			row.category ? (
				<Tag className="rounded-md border-slate-200 bg-slate-50 text-slate-500">
					{ticketCategoryLabel(row.category)}
				</Tag>
			) : (
				<Text className="text-xs italic text-slate-400">—</Text>
			),
	},
	{
		title: "Muhimlik",
		key: "priority",
		width: 110,
		render: (_, row) => (
			<Tag color={TICKET_PRIORITY_COLORS[row.priority]} className="rounded-md font-bold">
				{TICKET_PRIORITY_LABELS[row.priority]}
			</Tag>
		),
	},
	{
		title: "Holat",
		key: "status",
		width: 140,
		render: (_, row) => (
			<Tag color={TICKET_STATUS_COLORS[row.status]} className="rounded-md font-bold">
				{TICKET_STATUS_LABELS[row.status]}
			</Tag>
		),
	},
	{
		title: "Mijoz",
		key: "contact",
		width: 190,
		render: (_, row) => (
			<div className="flex flex-col">
				<span className="text-xs font-bold text-slate-700">{row.contactName ?? "Noma'lum"}</span>
				<span className="font-mono text-[10px] text-slate-400">
					{formatReportPhone(row.contactPhone)}
				</span>
			</div>
		),
	},
	{
		title: "Yaratuvchi",
		key: "createdBy",
		width: 170,
		render: (_, row) => (
			<div className="flex flex-col">
				<span className="text-xs font-bold text-slate-700">{row.createdByUsername ?? "Xodim"}</span>
				<span className="font-mono text-[10px] text-slate-400">
					{formatReportPhone(row.createdByPhone)}
				</span>
			</div>
		),
	},
	{
		title: "Yaratilgan",
		key: "createdAt",
		width: 140,
		render: (_, row) => (
			<span className="text-xs font-bold text-slate-700">{formatDateTime(row.createdAt)}</span>
		),
	},
	{
		title: "Yopilgan",
		key: "closedAt",
		width: 140,
		render: (_, row) =>
			row.closedAt ? (
				<span className="text-xs font-bold text-slate-700">{formatDateTime(row.closedAt)}</span>
			) : (
				<Text className="text-xs italic text-slate-400">yopilmagan</Text>
			),
	},
	{
		title: "Hal qilish",
		key: "resolutionHours",
		width: 120,
		align: "right",
		render: (_, row) =>
			row.resolutionHours === null ? (
				<Text className="text-[11px] italic text-slate-400">—</Text>
			) : (
				<span className="text-xs font-bold tabular-nums text-slate-700">
					{formatHours(row.resolutionHours)}
				</span>
			),
	},
	{
		title: "AI kayfiyat",
		key: "aiSentiment",
		width: 130,
		render: (_, row) =>
			row.aiSentiment ? (
				<Tag color={SENTIMENT_COLORS[row.aiSentiment]} className="rounded-md font-bold">
					{SENTIMENT_LABELS[row.aiSentiment]}
					{row.aiConfidence === null ? "" : ` · ${row.aiConfidence}%`}
				</Tag>
			) : (
				<Text className="text-xs italic text-slate-400">tahlil yo'q</Text>
			),
	},
];

export function TicketsReportTable({ rows, summary, meta, isLoading, onPageChange }: Props) {
	return (
		<ReportCard>
			<Table<TicketReportRow>
				columns={columns}
				dataSource={rows}
				loading={isLoading}
				rowKey="id"
				size="middle"
				scroll={{ x: 1600 }}
				pagination={buildPagination(meta, onPageChange)}
				locale={buildEmptyLocale("Tanlangan oraliqda murojaat topilmadi")}
				summary={() =>
					rows.length === 0 || !summary ? null : (
						<Table.Summary fixed>
							<Table.Summary.Row className="bg-slate-50">
								<Table.Summary.Cell index={0}>
									<span className="text-xs font-black text-slate-900">
										JAMI — {summary.totalTickets} murojaat
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={1} />
								<Table.Summary.Cell index={2}>
									<span className="text-[11px] font-bold text-slate-500">
										{summary.priorityHigh} yuqori
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={3}>
									<span className="text-[11px] font-bold text-slate-500">
										Yopilish: {formatPercent(summary.closedRate)}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={4} />
								<Table.Summary.Cell index={5} />
								<Table.Summary.Cell index={6} />
								<Table.Summary.Cell index={7} />
								<Table.Summary.Cell index={8} align="right">
									<span className="text-xs font-black tabular-nums text-slate-900">
										{formatHours(summary.avgResolutionHours)}
									</span>
								</Table.Summary.Cell>
								<Table.Summary.Cell index={9}>
									<span className="text-[11px] font-bold text-slate-500">
										{summary.sentimentNegative} manfiy
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
