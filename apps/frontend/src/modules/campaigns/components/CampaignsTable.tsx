import {
	CloseCircleOutlined,
	DeleteOutlined,
	EditOutlined,
	PauseCircleOutlined,
	PlayCircleOutlined,
} from "@ant-design/icons";
import { Button, Card, Empty, Popconfirm, Progress, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useNavigate } from "react-router-dom";
// The campaign page and /ai-costs must never disagree about a figure, so the
// spend is not only computed by the same backend code (lib/ai-cost) - it is
// rendered by the same formatters too.
import { formatUsd, NO_DATA } from "@/modules/ai-costs/utils/format";
import { formatDateTime } from "@/shared/utils/datetime";
import type { Campaign, CampaignProgress } from "../types";
import {
	CAMPAIGN_KIND_LABELS,
	CAMPAIGN_STATUS_COLORS,
	CAMPAIGN_STATUS_LABELS,
} from "../utils/labels";

interface Props {
	campaigns: Campaign[];
	progressMap: Map<string, CampaignProgress>;
	meta?: { total: number; page: number; limit: number };
	isLoading: boolean;
	canManage: boolean;
	onPageChange: (page: number, limit: number) => void;
	onStart: (campaign: Campaign) => void;
	onPause: (campaign: Campaign) => void;
	onCancel: (campaign: Campaign) => void;
	onEdit: (campaign: Campaign) => void;
	onDelete: (campaign: Campaign) => void;
	isMutating: boolean;
}

/** Navbat holati bitta chiziqda: qancha ishlangan, qancha qolgan. */
function QueueCell({ campaign, progress }: { campaign: Campaign; progress?: CampaignProgress }) {
	const total = progress?.leads.total ?? campaign.leadCount;
	const pending = progress?.leads.pending ?? campaign.pendingCount;
	const calling = progress?.leads.calling ?? 0;
	const handled = Math.max(0, total - pending - calling);
	const percent = total === 0 ? 0 : Math.round((handled / total) * 100);

	if (total === 0) {
		return <span className="text-[11px] font-medium text-slate-400 italic">Ro'yxat bo'sh</span>;
	}

	return (
		<div className="min-w-[140px]">
			<Progress
				percent={percent}
				size="small"
				status={campaign.status === "running" ? "active" : "normal"}
				strokeColor={campaign.status === "cancelled" ? "#f43f5e" : "#2563eb"}
			/>
			<div className="text-[11px] font-medium text-slate-500">
				{handled} / {total} ishlandi
				{calling > 0 && <span className="font-bold text-blue-600"> · {calling} ta liniyada</span>}
			</div>
		</div>
	);
}

/**
 * Spend, with the same three-way answer /ai-costs gives.
 *
 * A role that may not see cost gets a dash and a reason, an unpriced session
 * gets "ma'lumot yo'q" and NOT a zero, and a draft is left blank because it has
 * never dialled anybody - showing "$0.00" there would imply it was measured.
 */
function SpendCell({ campaign, progress }: { campaign: Campaign; progress?: CampaignProgress }) {
	if (campaign.status === "draft") {
		return <span className="text-[11px] text-slate-300">—</span>;
	}

	if (progress === undefined) {
		return <span className="text-[11px] text-slate-300">…</span>;
	}

	if (!progress.spend.visible) {
		return (
			<Tooltip title="Xarajatni faqat nazoratchi va administrator ko'radi">
				<span className="text-[11px] text-slate-300">—</span>
			</Tooltip>
		);
	}

	return (
		<div className="flex flex-col items-end">
			<span className="text-xs font-bold text-slate-900 tabular-nums">
				{progress.spend.costUsd === null ? NO_DATA : formatUsd(progress.spend.costUsd)}
			</span>
			<span className="text-[10px] font-medium text-slate-400">
				{progress.spend.sessions ?? 0} ta suhbat
			</span>
		</div>
	);
}

export function CampaignsTable({
	campaigns,
	progressMap,
	meta,
	isLoading,
	canManage,
	onPageChange,
	onStart,
	onPause,
	onCancel,
	onEdit,
	onDelete,
	isMutating,
}: Props) {
	const navigate = useNavigate();

	const columns: ColumnsType<Campaign> = [
		{
			title: "Kampaniya",
			key: "name",
			width: 300,
			render: (_, row) => (
				<div className="flex flex-col gap-1">
					<span className="leading-tight font-bold text-slate-900">{row.name}</span>
					<span className="line-clamp-2 text-[11px] leading-snug font-medium text-slate-500">
						{row.purpose}
					</span>
					<div className="flex flex-wrap items-center gap-1">
						<Tag className="m-0 rounded-md border-none text-[10px] font-bold">
							{CAMPAIGN_KIND_LABELS[row.kind]}
						</Tag>
						{row.agentProfileName !== null && (
							<Tag color="geekblue" className="m-0 rounded-md border-none text-[10px] font-bold">
								{row.agentProfileName}
							</Tag>
						)}
					</div>
				</div>
			),
		},
		{
			title: "Holat",
			key: "status",
			width: 150,
			render: (_, row) => (
				<div className="flex flex-col gap-1">
					<Tag
						color={CAMPAIGN_STATUS_COLORS[row.status]}
						className="m-0 w-fit rounded-md border-none font-bold"
					>
						{CAMPAIGN_STATUS_LABELS[row.status]}
					</Tag>
					{row.startedByName !== null && (
						<Tooltip title={`Ishga tushirgan: ${row.startedByName}`}>
							<span className="text-[10px] font-medium text-slate-400">
								{row.startedByName} · {formatDateTime(row.startedAt)}
							</span>
						</Tooltip>
					)}
				</div>
			),
		},
		{
			title: "Navbat",
			key: "queue",
			width: 180,
			render: (_, row) => <QueueCell campaign={row} progress={progressMap.get(row.id)} />,
		},
		{
			title: "Xarajat",
			key: "spend",
			width: 110,
			align: "right",
			render: (_, row) => <SpendCell campaign={row} progress={progressMap.get(row.id)} />,
		},
		{
			title: "Oyna",
			key: "window",
			width: 130,
			render: (_, row) => {
				const progress = progressMap.get(row.id);

				return (
					<div className="flex flex-col">
						<span className="text-xs font-bold text-slate-700 tabular-nums">
							{row.callWindowStart} – {row.callWindowEnd}
						</span>
						{progress !== undefined && (
							<span
								className={`text-[10px] font-bold ${progress.window.openNow ? "text-emerald-600" : "text-amber-600"}`}
							>
								{progress.window.openNow ? "Hozir ochiq" : "Hozir yopiq"}
							</span>
						)}
					</div>
				);
			},
		},
		{
			title: "Amallar",
			key: "actions",
			width: 190,
			align: "right",
			fixed: "right",
			render: (_, row) => {
				if (!canManage) {
					return <span className="text-[11px] text-slate-300">—</span>;
				}

				const actions = row.availableActions;

				return (
					<Space size={4} onClick={(event) => event.stopPropagation()}>
						{actions.includes("start") && (
							<Tooltip title={row.status === "paused" ? "Davom ettirish" : "Ishga tushirish"}>
								<Button
									type="text"
									icon={<PlayCircleOutlined className="text-emerald-600" />}
									onClick={() => onStart(row)}
									className="hover:bg-emerald-50"
								/>
							</Tooltip>
						)}
						{actions.includes("pause") && (
							<Tooltip title="Pauza">
								<Button
									type="text"
									icon={<PauseCircleOutlined className="text-amber-500" />}
									loading={isMutating}
									onClick={() => onPause(row)}
									className="hover:bg-amber-50"
								/>
							</Tooltip>
						)}
						{actions.includes("cancel") && (
							<Tooltip title="Bekor qilish">
								<Popconfirm
									title="Kampaniyani bekor qilish"
									description="Bu holat qaytarilmaydi — bekor qilingan kampaniya qayta ishga tushmaydi."
									okText="Ha, bekor qilinsin"
									cancelText="Yo'q"
									okButtonProps={{ danger: true, loading: isMutating }}
									onConfirm={() => onCancel(row)}
								>
									<Button
										type="text"
										icon={<CloseCircleOutlined className="text-rose-500" />}
										className="hover:bg-rose-50"
									/>
								</Popconfirm>
							</Tooltip>
						)}
						{(row.status === "draft" || row.status === "running" || row.status === "paused") && (
							<Tooltip title="Tahrirlash">
								<Button
									type="text"
									icon={<EditOutlined className="text-blue-600" />}
									onClick={() => onEdit(row)}
									className="hover:bg-blue-50"
								/>
							</Tooltip>
						)}
						{row.status === "draft" && (
							<Tooltip title="O'chirish">
								<Popconfirm
									title="Qoralamani o'chirish"
									description="Ro'yxatdagi raqamlar ham o'chadi. Bu kampaniya hech kimga qo'ng'iroq qilmagan."
									okText="O'chirish"
									cancelText="Yo'q"
									okButtonProps={{ danger: true, loading: isMutating }}
									onConfirm={() => onDelete(row)}
								>
									<Button
										type="text"
										icon={<DeleteOutlined className="text-slate-400" />}
										className="hover:bg-slate-100"
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
		<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
			<Table<Campaign>
				columns={columns}
				dataSource={campaigns}
				loading={isLoading}
				rowKey="id"
				size="middle"
				scroll={{ x: 1100 }}
				pagination={{
					current: meta?.page,
					pageSize: meta?.limit,
					total: meta?.total,
					showSizeChanger: true,
					showTotal: (total, range) => `${range[0]}–${range[1]} / jami ${total}`,
					className: "px-6 pb-4",
					onChange: onPageChange,
				}}
				onRow={(row) => ({
					onClick: () => navigate(`/campaigns/${row.id}`),
					className: "cursor-pointer transition-colors",
				})}
				locale={{
					emptyText: (
						<Empty
							className="py-12"
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description="Hali kampaniya yaratilmagan"
						/>
					),
				}}
			/>
		</Card>
	);
}
