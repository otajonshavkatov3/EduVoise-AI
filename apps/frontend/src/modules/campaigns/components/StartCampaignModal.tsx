import {
	ClockCircleOutlined,
	PhoneOutlined,
	PlayCircleOutlined,
	SoundOutlined,
	TeamOutlined,
} from "@ant-design/icons";
import { Alert, App, Button, Modal, Skeleton } from "antd";
import type { ReactNode } from "react";
import { useActiveAgentProfile } from "@/modules/ai-agent/hooks/useAiAgent";
import { useCampaignProgress, useStartCampaign } from "../hooks/useCampaigns";
import type { Campaign, CampaignProgress, StartResult } from "../types";
import { CAMPAIGN_KIND_LABELS } from "../utils/labels";
import { composeOpeningLine, toPreviewLanguage } from "../utils/openingLine";
import { TrunkNotice } from "./TrunkNotice";

interface Props {
	open: boolean;
	campaign: Campaign | null;
	onClose: () => void;
}

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
	return (
		<div className="flex gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
			<div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
				{icon}
			</div>
			<div className="min-w-0">
				<div className="text-[9px] font-bold tracking-widest text-slate-400 uppercase">{label}</div>
				<div className="text-sm leading-relaxed font-bold text-slate-900">{children}</div>
			</div>
		</div>
	);
}

/** The three facts, once the queue and the window have actually been read. */
function StartFacts({
	campaign,
	progress,
	pending,
	opening,
}: {
	campaign: Campaign;
	progress: CampaignProgress | undefined;
	pending: number;
	opening: ReturnType<typeof composeOpeningLine>;
}) {
	return (
		<div className="grid grid-cols-1 gap-3">
			<Fact icon={<TeamOutlined />} label="Nechta raqamga qo'ng'iroq qilinadi">
				{pending} ta raqam navbatda
				{progress !== undefined && progress.leads.total !== pending && (
					<span className="font-medium text-slate-500">
						{" "}
						(ro'yxatda jami {progress.leads.total} ta)
					</span>
				)}
				<div className="text-xs font-medium text-slate-500">
					Har biriga ko'pi bilan {campaign.maxAttempts} marta urinib ko'riladi, bir vaqtda{" "}
					{campaign.concurrency} ta qo'ng'iroq.
				</div>
			</Fact>

			<Fact icon={<SoundOutlined />} label="AI nima deb boshlaydi">
				<span className="font-medium text-slate-600">{opening.identity}</span>{" "}
				<span className="text-slate-900">{opening.reason}</span>
				<div className="mt-1 text-xs font-medium text-slate-500">
					Tur: {CAMPAIGN_KIND_LABELS[campaign.kind]}
				</div>
			</Fact>

			<Fact icon={<ClockCircleOutlined />} label="Qaysi soatlarda">
				{campaign.callWindowStart} – {campaign.callWindowEnd}
				{progress !== undefined && (
					<>
						<span className="font-medium text-slate-500"> ({progress.window.timeZone})</span>
						<div
							className={`text-xs font-bold ${progress.window.openNow ? "text-emerald-600" : "text-amber-600"}`}
						>
							{progress.window.message}
						</div>
					</>
				)}
			</Fact>

			{progress !== undefined && <TrunkNotice dialing={progress.dialing} compact />}
		</div>
	);
}

/** What the run that just began has to say for itself. */
function startedContent(result: StartResult) {
	if (result.warnings.length === 0) {
		return <span>{result.window.message}</span>;
	}

	return (
		<div>
			<p className="mb-2">{result.window.message}</p>
			<ul className="m-0 list-disc space-y-1 pl-4 text-slate-600">
				{result.warnings.map((warning) => (
					<li key={warning}>{warning}</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Pressing "start" rings real people and spends real money, so it is the one
 * button on these screens that refuses to be a one-click action.
 *
 * The confirmation states the three facts somebody needs and cannot get from the
 * button's label: HOW MANY phones will ring, WHAT the agent will say it is
 * calling about (the composed opening line, not the raw field), and INSIDE WHAT
 * HOURS - plus whether this deployment can place the calls at all.
 *
 * Every number here is read from `GET /{id}/progress` rather than from the list
 * row: the queue moves while the modal is open, and "500 leads" from a
 * thirty-second-old cache is exactly the figure somebody would quote back later.
 */
export function StartCampaignModal({ open, campaign, onClose }: Props) {
	// `App.useApp()` rather than the static `Modal.success`: the static one is
	// rendered outside the ConfigProvider, so it would come out unthemed and in
	// antd's English, in the middle of an Uzbek page.
	const { modal } = App.useApp();
	const progressQuery = useCampaignProgress(
		open && campaign !== null ? campaign.id : undefined,
		false
	);
	const activeProfileQuery = useActiveAgentProfile();
	const startCampaign = useStartCampaign();

	const progress = progressQuery.data;
	const activeProfile = activeProfileQuery.data?.data;

	const opening =
		campaign === null
			? null
			: composeOpeningLine({
					businessName: activeProfile?.businessName ?? "",
					recordingNotice: activeProfile?.recordingNotice ?? null,
					language: toPreviewLanguage(activeProfile?.language),
					purpose: campaign.purpose,
				});

	const handleStart = async () => {
		if (campaign === null) {
			return;
		}

		try {
			const result = await startCampaign.mutateAsync(campaign.id);

			// The response is the only place the window and trunk warnings appear for
			// the run that just began, so they are surfaced instead of a generic toast.
			modal.success({
				title: "Kampaniya ishga tushdi",
				centered: true,
				okText: "Yopish",
				content: startedContent(result),
			});
			onClose();
		} catch {
			// Sabab hook'dagi toast'da — masalan navbatda raqam yo'q.
		}
	};

	const pending = progress?.leads.pending ?? campaign?.pendingCount ?? 0;
	const isResume = campaign?.status === "paused";

	return (
		<Modal
			title={
				<div className="flex items-center gap-2 pb-2">
					<PlayCircleOutlined className="text-emerald-600" />
					<span className="font-extrabold tracking-tight text-slate-900 uppercase">
						{isResume ? "Kampaniyani davom ettirish" : "Kampaniyani ishga tushirish"}
					</span>
				</div>
			}
			open={open}
			onCancel={onClose}
			footer={null}
			width={680}
			centered
			styles={{ mask: { backdropFilter: "blur(4px)" } }}
		>
			{campaign === null ? null : (
				<div className="mt-2">
					<Alert
						type="warning"
						showIcon
						className="mb-4 rounded-2xl"
						message="Bu haqiqiy qo'ng'iroqlar"
						description="Tasdiqlangandan keyin quyidagi raqamlarga AI o'zi qo'ng'iroq qila boshlaydi. Har bir suhbat AI xarajatiga tushadi va /ai-costs sahifasida ko'rinadi."
					/>

					{progressQuery.isLoading || opening === null ? (
						<Skeleton active paragraph={{ rows: 4 }} />
					) : (
						<StartFacts
							campaign={campaign}
							progress={progress}
							pending={pending}
							opening={opening}
						/>
					)}

					<div className="mt-6 flex gap-3 border-t border-slate-100 pt-5">
						<Button className="h-12 flex-1 rounded-xl font-bold" onClick={onClose}>
							Bekor qilish
						</Button>
						<Button
							type="primary"
							icon={<PhoneOutlined />}
							loading={startCampaign.isPending}
							onClick={handleStart}
							className="h-12 flex-1 rounded-xl font-bold shadow-lg shadow-emerald-500/20"
							style={{ background: "#059669" }}
						>
							{isResume ? "Davom ettirish" : `Ha, ${pending} ta raqamga qo'ng'iroq qilinsin`}
						</Button>
					</div>
				</div>
			)}
		</Modal>
	);
}
