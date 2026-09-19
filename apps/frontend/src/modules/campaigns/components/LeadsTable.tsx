import { PhoneOutlined, RedoOutlined, SearchOutlined, StopOutlined } from "@ant-design/icons";
import { Button, Card, Empty, Input, Popconfirm, Select, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { useDebouncedCallback } from "@/shared/hooks/useDebouncedCallback";
import { formatDateTime } from "@/shared/utils/datetime";
import type { CampaignLead, CampaignLeadStatus, CampaignOutcome, LeadListFilters } from "../types";
import {
	LEAD_STATUS_COLORS,
	LEAD_STATUS_LABELS,
	OUTCOME_COLORS,
	OUTCOME_LABELS,
	optionsFrom,
} from "../utils/labels";

interface Props {
	leads: CampaignLead[];
	meta?: { total: number; page: number; limit: number };
	filters: LeadListFilters;
	isLoading: boolean;
	canManage: boolean;
	maxAttempts: number;
	onFiltersChange: (patch: Partial<LeadListFilters>) => void;
	onOpen: (lead: CampaignLead) => void;
	onRequeue: (lead: CampaignLead) => void;
	onSkip: (lead: CampaignLead) => void;
	isMutating: boolean;
}

const STATUS_OPTIONS = optionsFrom(LEAD_STATUS_LABELS);
const OUTCOME_OPTIONS = optionsFrom(OUTCOME_LABELS);

const CALL_OPTIONS = [
	{ value: "true", label: "Qo'ng'iroq bo'lgan" },
	{ value: "false", label: "Qo'ng'iroq bo'lmagan" },
];

/**
 * The queue, in the order the dialer will work through it.
 *
 * Each row's call links straight to `/calls/:id`, where the transcript, the
 * recording, the AI analysis and the cost already live. None of that is rebuilt
 * here: a campaign row's job is to say which call it was, not to show it again.
 */
export function LeadsTable({
	leads,
	meta,
	filters,
	isLoading,
	canManage,
	maxAttempts,
	onFiltersChange,
	onOpen,
	onRequeue,
	onSkip,
	isMutating,
}: Props) {
	const handleSearch = useDebouncedCallback((value: string) => onFiltersChange({ q: value }));

	const columns: ColumnsType<CampaignLead> = [
		{
			title: "Raqam",
			key: "phone",
			width: 210,
			fixed: "left",
			render: (_, row) => (
				<div className="flex flex-col">
					<span className="font-mono font-bold text-slate-900">{row.phoneDisplay}</span>
					<span className="text-[11px] font-medium text-slate-500">
						{row.fullName ?? "Ismi yo'q"}
					</span>
				</div>
			),
		},
		{
			title: "Holat",
			key: "status",
			width: 140,
			render: (_, row) => (
				<Tag
					color={LEAD_STATUS_COLORS[row.status]}
					className="m-0 rounded-md border-none font-bold"
				>
					{LEAD_STATUS_LABELS[row.status]}
				</Tag>
			),
		},
		{
			title: "Natija",
			key: "outcome",
			width: 190,
			render: (_, row) =>
				row.outcome === null ? (
					<span className="text-[11px] text-slate-300">—</span>
				) : (
					<Tag color={OUTCOME_COLORS[row.outcome]} className="m-0 rounded-md border-none font-bold">
						{OUTCOME_LABELS[row.outcome]}
					</Tag>
				),
		},
		{
			title: "Urinishlar",
			key: "attempts",
			width: 170,
			render: (_, row) => (
				<div className="flex flex-col">
					<span className="text-xs font-bold text-slate-700 tabular-nums">
						{row.attempts} / {maxAttempts}
					</span>
					<span className="text-[10px] font-medium text-slate-400">
						{row.lastAttemptAt !== null && <>oxirgi: {formatDateTime(row.lastAttemptAt)}</>}
						{row.lastAttemptAt === null && row.nextAttemptAt !== null && (
							<>keyingi: {formatDateTime(row.nextAttemptAt)}</>
						)}
						{row.lastAttemptAt === null && row.nextAttemptAt === null && "hali terilmagan"}
					</span>
				</div>
			),
		},
		{
			title: "Qo'ng'iroq",
			key: "call",
			width: 150,
			render: (_, row) =>
				row.callId === null ? (
					<span className="text-[11px] text-slate-300">—</span>
				) : (
					<Link
						to={`/calls/${row.callId}`}
						onClick={(event) => event.stopPropagation()}
						className="flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
					>
						<PhoneOutlined /> Kartani ochish
					</Link>
				),
		},
		{
			title: "Izoh",
			key: "note",
			render: (_, row) =>
				row.note === null ? (
					<span className="text-[11px] text-slate-300">—</span>
				) : (
					<Tooltip title={row.note}>
						<span className="line-clamp-2 text-[11px] font-medium text-slate-600">{row.note}</span>
					</Tooltip>
				),
		},
		{
			title: "",
			key: "actions",
			width: 100,
			align: "right",
			fixed: "right",
			render: (_, row) => {
				if (!canManage) {
					return null;
				}

				// `Space`, not a bare div: the row itself opens the lead, so the click has
				// to stop here - and a static element with a click handler is not something
				// a keyboard user can reach.
				return (
					<Space size={4} onClick={(event) => event.stopPropagation()}>
						{row.status !== "pending" && (
							<Tooltip title="Navbatga qaytarish">
								<Button
									type="text"
									size="small"
									icon={<RedoOutlined className="text-blue-600" />}
									loading={isMutating}
									onClick={() => onRequeue(row)}
								/>
							</Tooltip>
						)}
						{(row.status === "pending" || row.status === "failed") && (
							<Tooltip title="Bu raqamga qo'ng'iroq qilinmasin (shu kampaniyada)">
								<Popconfirm
									title="Navbatdan chiqarish"
									description="Shu kampaniya doirasida bu raqam terilmaydi."
									okText="Ha"
									cancelText="Yo'q"
									onConfirm={() => onSkip(row)}
								>
									<Button
										type="text"
										size="small"
										icon={<StopOutlined className="text-slate-400" />}
									/>
								</Popconfirm>
							</Tooltip>
						)}
					</Space>
				);
			},
		},
	];

	return (
		<div>
			<Card className="mb-4 rounded-2xl border-none shadow-sm">
				<div className="flex flex-wrap items-center gap-3">
					<Input
						allowClear
						prefix={<SearchOutlined className="text-slate-400" />}
						placeholder="Raqam yoki ism"
						onChange={(event) => handleSearch(event.target.value)}
						className="h-11 w-full rounded-xl md:w-64"
					/>
					<Select<CampaignLeadStatus>
						allowClear
						placeholder="Navbat holati"
						value={filters.status}
						options={STATUS_OPTIONS}
						onChange={(value) => onFiltersChange({ status: value })}
						className="h-11 w-full md:w-52"
					/>
					<Select<CampaignOutcome>
						allowClear
						placeholder="Natija"
						value={filters.outcome}
						options={OUTCOME_OPTIONS}
						onChange={(value) => onFiltersChange({ outcome: value })}
						className="h-11 w-full md:w-60"
					/>
					<Select<"true" | "false">
						allowClear
						placeholder="Qo'ng'iroq"
						value={filters.hasCall}
						options={CALL_OPTIONS}
						onChange={(value) => onFiltersChange({ hasCall: value })}
						className="h-11 w-full md:w-52"
					/>
				</div>
			</Card>

			<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
				<Table<CampaignLead>
					columns={columns}
					dataSource={leads}
					loading={isLoading}
					rowKey="id"
					size="middle"
					scroll={{ x: 1180 }}
					onRow={(row) => ({
						onClick: () => onOpen(row),
						className: "cursor-pointer transition-colors",
					})}
					pagination={{
						current: meta?.page,
						pageSize: meta?.limit,
						total: meta?.total,
						showSizeChanger: true,
						showTotal: (total, range) => `${range[0]}–${range[1]} / jami ${total}`,
						className: "px-6 pb-4",
						onChange: (page, limit) => onFiltersChange({ page, limit }),
					}}
					locale={{
						emptyText: (
							<Empty
								className="py-12"
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description="Bu kampaniyada raqam yo'q — ro'yxatni import qiling"
							/>
						),
					}}
				/>
			</Card>
		</div>
	);
}
