import {
	CloseCircleOutlined,
	EditOutlined,
	PauseCircleOutlined,
	PlayCircleOutlined,
} from "@ant-design/icons";
import { Button, Popconfirm, Tag } from "antd";
import { formatDateTime } from "@/shared/utils/datetime";
import type { Campaign } from "../types";
import { formatMinutes } from "../utils/form";
import {
	CAMPAIGN_KIND_LABELS,
	CAMPAIGN_STATUS_COLORS,
	CAMPAIGN_STATUS_LABELS,
} from "../utils/labels";

interface Props {
	campaign: Campaign;
	canManage: boolean;
	isPausing: boolean;
	isCancelling: boolean;
	onStart: () => void;
	onPause: () => void;
	onCancel: () => void;
	onEdit: () => void;
}

/**
 * Name, state, and the four decisions somebody can make about a campaign.
 *
 * Which buttons exist is the server's answer (`availableActions`), not a switch
 * over the status here: the transition table lives in `lib/campaigns` and a
 * second copy in the UI would eventually offer a move the API refuses.
 */
export function CampaignDetailHeader({
	campaign,
	canManage,
	isPausing,
	isCancelling,
	onStart,
	onPause,
	onCancel,
	onEdit,
}: Props) {
	const actions = campaign.availableActions;
	const isEditable = campaign.status !== "finished" && campaign.status !== "cancelled";

	return (
		<div className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
			<div className="min-w-0">
				<div className="mb-2 flex flex-wrap items-center gap-2">
					<h1 className="text-3xl font-black tracking-tight text-slate-900">{campaign.name}</h1>
					<Tag
						color={CAMPAIGN_STATUS_COLORS[campaign.status]}
						className="m-0 rounded-md border-none font-bold"
					>
						{CAMPAIGN_STATUS_LABELS[campaign.status]}
					</Tag>
					<Tag className="m-0 rounded-md border-none font-bold">
						{CAMPAIGN_KIND_LABELS[campaign.kind]}
					</Tag>
				</div>
				<p className="m-0 text-xs font-medium text-slate-500">
					{campaign.createdByName !== null && <>Yaratgan: {campaign.createdByName} · </>}
					{campaign.startedByName !== null && (
						<>
							Ishga tushirgan: {campaign.startedByName} ({formatDateTime(campaign.startedAt)}) ·{" "}
						</>
					)}
					Har raqamga {campaign.maxAttempts} martagacha, orasida{" "}
					{formatMinutes(campaign.retryDelayMinutes)} · bir vaqtda {campaign.concurrency} ta
					qo'ng'iroq
					{campaign.agentProfileName !== null && <> · profil: {campaign.agentProfileName}</>}
				</p>
			</div>

			{canManage && (
				<div className="flex flex-wrap items-center gap-2">
					{actions.includes("start") && (
						<Button
							type="primary"
							icon={<PlayCircleOutlined />}
							onClick={onStart}
							className="h-11 rounded-xl px-5 font-bold shadow-lg shadow-emerald-500/20"
							style={{ background: "#059669" }}
						>
							{campaign.status === "paused" ? "Davom ettirish" : "Ishga tushirish"}
						</Button>
					)}
					{actions.includes("pause") && (
						<Button
							icon={<PauseCircleOutlined />}
							loading={isPausing}
							onClick={onPause}
							className="h-11 rounded-xl px-5 font-bold"
						>
							Pauza
						</Button>
					)}
					{actions.includes("cancel") && (
						<Popconfirm
							title="Kampaniyani bekor qilish"
							description="Bu holat qaytarilmaydi — bekor qilingan kampaniya qayta ishga tushmaydi."
							okText="Ha, bekor qilinsin"
							cancelText="Yo'q"
							okButtonProps={{ danger: true, loading: isCancelling }}
							onConfirm={onCancel}
						>
							<Button
								danger
								icon={<CloseCircleOutlined />}
								className="h-11 rounded-xl px-5 font-bold"
							>
								Bekor qilish
							</Button>
						</Popconfirm>
					)}
					{isEditable && (
						<Button
							icon={<EditOutlined />}
							onClick={onEdit}
							className="h-11 rounded-xl px-5 font-bold"
						>
							Tahrirlash
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
