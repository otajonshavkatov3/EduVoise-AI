import { ArrowLeftOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Segmented, Skeleton } from "antd";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useActiveAgentProfile, useAgentProfiles } from "@/modules/ai-agent/hooks/useAiAgent";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { CampaignDetailHeader } from "../components/CampaignDetailHeader";
import { CampaignFormModal } from "../components/CampaignFormModal";
import { CampaignProgressPanel } from "../components/CampaignProgressPanel";
import { LeadDetailModal } from "../components/LeadDetailModal";
import { LeadImportPanel } from "../components/LeadImportPanel";
import { LeadsTable } from "../components/LeadsTable";
import { OpeningLinePreview } from "../components/OpeningLinePreview";
import { StartCampaignModal } from "../components/StartCampaignModal";
import {
	useCampaign,
	useCampaignLeads,
	useCampaignProgress,
	useCancelCampaign,
	usePauseCampaign,
	useUpdateLead,
} from "../hooks/useCampaigns";
import type { CampaignLead, LeadListFilters } from "../types";
import { toPreviewLanguage } from "../utils/openingLine";

type Tab = "leads" | "import";

/** Tugagan kampaniyaga raqam qo'shilmaydi — backend ham shuni rad etadi. */
function importDisabledReason(status: string): string | null {
	if (status === "finished") {
		return "Kampaniya tugagan — raqam qo'shib bo'lmaydi. Yangi kampaniya yarating.";
	}

	if (status === "cancelled") {
		return "Kampaniya bekor qilingan — raqam qo'shib bo'lmaydi. Yangi kampaniya yarating.";
	}

	return null;
}

export default function CampaignDetailPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const user = useAuthStore((state) => state.user);
	const canManage = user?.role === "admin" || user?.role === "supervisor";

	const [tab, setTab] = useState<Tab>("leads");
	const [leadFilters, setLeadFilters] = useState<LeadListFilters>({ page: 1, limit: 20 });
	const [openLead, setOpenLead] = useState<CampaignLead | null>(null);
	const [isFormOpen, setIsFormOpen] = useState(false);
	const [isStartOpen, setIsStartOpen] = useState(false);

	const campaignQuery = useCampaign(id);
	const campaign = campaignQuery.data;
	const isLive = campaign?.status === "running";

	const progressQuery = useCampaignProgress(id, isLive);
	const leadsQuery = useCampaignLeads(id, leadFilters, isLive);
	const activeProfileQuery = useActiveAgentProfile();
	const profilesQuery = useAgentProfiles();

	const pauseCampaign = usePauseCampaign();
	const cancelCampaign = useCancelCampaign();
	const updateLead = useUpdateLead();

	const handleLeadFilters = (patch: Partial<LeadListFilters>) => {
		// A page change keeps the page; anything else resets to the first one, or the
		// filter would be applied to page 7 of a list that is now two pages long.
		setLeadFilters((current) => ({
			...current,
			...patch,
			page: patch.page ?? 1,
		}));
	};

	if (campaignQuery.isLoading) {
		return <Skeleton active paragraph={{ rows: 8 }} />;
	}

	if (campaignQuery.isError || campaign === undefined) {
		return (
			<Alert
				type="error"
				showIcon
				className="rounded-2xl"
				message="Kampaniya topilmadi"
				description={getApiErrorMessage(campaignQuery.error, "Server bilan aloqa yo'q")}
				action={
					<Button size="small" onClick={() => navigate("/campaigns")}>
						Ro'yxatga qaytish
					</Button>
				}
			/>
		);
	}

	const activeProfile = activeProfileQuery.data?.data;
	// The preview has to name the profile that will actually speak. A campaign
	// with no `agentProfileId` uses whichever is active at dial time; one that
	// pinned a profile uses that profile's business name, and its recording
	// notice is not in the profile list, so that line is left out rather than
	// borrowed from a different profile.
	const pinnedProfile = profilesQuery.data?.items.find(
		(profile) => profile.id === campaign.agentProfileId
	);
	const usesActiveProfile = campaign.agentProfileId === null || pinnedProfile?.isActive === true;

	return (
		<div className="animate-fadeIn">
			<Link
				to="/campaigns"
				className="mb-4 inline-flex items-center gap-2 text-xs font-bold text-slate-500 hover:text-blue-600"
			>
				<ArrowLeftOutlined /> Kampaniyalar
			</Link>

			<CampaignDetailHeader
				campaign={campaign}
				canManage={canManage}
				isPausing={pauseCampaign.isPending}
				isCancelling={cancelCampaign.isPending}
				onStart={() => setIsStartOpen(true)}
				onPause={() => pauseCampaign.mutate(campaign.id)}
				onCancel={() => cancelCampaign.mutate(campaign.id)}
				onEdit={() => setIsFormOpen(true)}
			/>

			<Card className="mb-6 rounded-2xl border-none shadow-sm">
				<OpeningLinePreview
					businessName={pinnedProfile?.businessName ?? activeProfile?.businessName ?? ""}
					recordingNotice={activeProfile?.recordingNotice ?? null}
					language={toPreviewLanguage(pinnedProfile?.language ?? activeProfile?.language)}
					purpose={campaign.purpose}
					noticeKnown={usesActiveProfile}
				/>
				{campaign.script !== null && (
					<div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
						<div className="mb-1 text-[9px] font-bold tracking-widest text-slate-400 uppercase">
							Qo'shimcha ko'rsatmalar — ovoz chiqarib o'qilmaydi
						</div>
						<p className="m-0 text-xs leading-relaxed font-medium whitespace-pre-wrap text-slate-600">
							{campaign.script}
						</p>
					</div>
				)}
			</Card>

			{progressQuery.data !== undefined && <CampaignProgressPanel progress={progressQuery.data} />}

			<Segmented<Tab>
				value={tab}
				onChange={setTab}
				className="mb-4"
				size="large"
				options={[
					{ value: "leads", label: `Ro'yxat (${campaign.leadCount})` },
					...(canManage ? [{ value: "import" as const, label: "Import" }] : []),
				]}
			/>

			{tab === "import" && canManage ? (
				<LeadImportPanel
					campaignId={campaign.id}
					disabledReason={importDisabledReason(campaign.status)}
				/>
			) : (
				<LeadsTable
					leads={leadsQuery.data?.data.items ?? []}
					meta={leadsQuery.data?.data.meta}
					filters={leadFilters}
					isLoading={leadsQuery.isLoading}
					canManage={canManage}
					maxAttempts={campaign.maxAttempts}
					isMutating={updateLead.isPending}
					onFiltersChange={handleLeadFilters}
					onOpen={setOpenLead}
					onRequeue={(lead) =>
						updateLead.mutate({ id: campaign.id, leadId: lead.id, body: { action: "requeue" } })
					}
					onSkip={(lead) =>
						updateLead.mutate({ id: campaign.id, leadId: lead.id, body: { action: "skip" } })
					}
				/>
			)}

			<LeadDetailModal
				open={openLead !== null}
				campaignId={campaign.id}
				lead={openLead}
				canManage={canManage}
				onClose={() => setOpenLead(null)}
			/>

			<CampaignFormModal
				open={isFormOpen}
				campaign={campaign}
				onClose={() => setIsFormOpen(false)}
			/>

			<StartCampaignModal
				open={isStartOpen}
				campaign={campaign}
				onClose={() => setIsStartOpen(false)}
			/>
		</div>
	);
}
