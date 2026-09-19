import { NotificationOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Segmented } from "antd";
import { useState } from "react";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { CampaignFilters } from "../components/CampaignFilters";
import { CampaignFormModal } from "../components/CampaignFormModal";
import { CampaignsTable } from "../components/CampaignsTable";
import { DoNotCallPanel } from "../components/DoNotCallPanel";
import { StartCampaignModal } from "../components/StartCampaignModal";
import { TrunkNotice } from "../components/TrunkNotice";
import {
	useCampaignProgressMap,
	useCampaigns,
	useCancelCampaign,
	usePauseCampaign,
	useRemoveCampaign,
} from "../hooks/useCampaigns";
import type { Campaign, CampaignListFilters } from "../types";

type Tab = "campaigns" | "dnc";

/** Ro'yxatning bir sahifasi. Har bir qatorning holati alohida so'rov bilan olinadi. */
const DEFAULT_LIMIT = 10;

export default function CampaignsPage() {
	const user = useAuthStore((state) => state.user);
	// The same two lists the backend uses: CAN_MANAGE and CAN_DELETE_DNC.
	const canManage = user?.role === "admin" || user?.role === "supervisor";
	const canDeleteDnc = user?.role === "admin";

	const [tab, setTab] = useState<Tab>("campaigns");
	const [filters, setFilters] = useState<CampaignListFilters>({ page: 1, limit: DEFAULT_LIMIT });
	const [editing, setEditing] = useState<Campaign | null>(null);
	const [isFormOpen, setIsFormOpen] = useState(false);
	const [starting, setStarting] = useState<Campaign | null>(null);

	const campaignsQuery = useCampaigns(filters);
	const campaigns = campaignsQuery.data?.data.items ?? [];
	const progressMap = useCampaignProgressMap(campaigns);

	const pauseCampaign = usePauseCampaign();
	const cancelCampaign = useCancelCampaign();
	const removeCampaign = useRemoveCampaign();

	/*
	 * The trunk banner is shown from measured data, never from an assumption.
	 *
	 * `dialing` is per campaign, but `trunkConfigured` inside it is a property of
	 * the deployment, so the first loaded progress answers it for the whole page.
	 * Until one has loaded (an empty list, or nothing but drafts) no claim is made
	 * either way - the start confirmation asks for that campaign's own readiness
	 * before anybody can dial.
	 */
	const anyDialing = [...progressMap.values()][0]?.dialing;

	const handleFilterChange = (patch: Partial<CampaignListFilters>) => {
		setFilters((current) => ({ ...current, ...patch, page: 1 }));
	};

	const openCreate = () => {
		setEditing(null);
		setIsFormOpen(true);
	};

	const openEdit = (campaign: Campaign) => {
		setEditing(campaign);
		setIsFormOpen(true);
	};

	return (
		<div className="animate-fadeIn">
			<div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-center">
				<div>
					<h1 className="flex items-center gap-3 text-3xl font-black tracking-tight text-slate-900">
						<NotificationOutlined className="text-blue-600" />
						Chiquvchi kampaniyalar
					</h1>
					<p className="font-medium text-slate-500">
						Raqamlar ro'yxati va qo'ng'iroq sababi beriladi — AI o'zi qo'ng'iroq qilib, natijani
						yozib qo'yadi
					</p>
				</div>
				{canManage && tab === "campaigns" && (
					<Button
						type="primary"
						icon={<PlusOutlined />}
						size="large"
						onClick={openCreate}
						className="h-12 rounded-xl px-6 font-bold shadow-lg shadow-blue-500/20"
					>
						Yangi kampaniya
					</Button>
				)}
			</div>

			<Segmented<Tab>
				value={tab}
				onChange={setTab}
				className="mb-6"
				size="large"
				options={[
					{ value: "campaigns", label: "Kampaniyalar" },
					{ value: "dnc", label: "Qo'ng'iroq qilinmasin" },
				]}
			/>

			{tab === "dnc" ? (
				<DoNotCallPanel canManage={canManage} canDelete={canDeleteDnc} />
			) : (
				<>
					{anyDialing !== undefined && <TrunkNotice dialing={anyDialing} />}

					{!canManage && (
						<Alert
							type="info"
							showIcon
							className="mb-4 rounded-2xl"
							message="Faqat ko'rish"
							description="Kampaniya yaratish, ishga tushirish va to'xtatish nazoratchi va administrator huquqi — bu /ai-costs bilan bir xil qoida, chunki kampaniya o'sha sahifadagi pulni sarflaydi."
						/>
					)}

					<CampaignFilters
						status={filters.status}
						kind={filters.kind}
						q={filters.q}
						onChange={handleFilterChange}
						onRefresh={() => campaignsQuery.refetch()}
						isFetching={campaignsQuery.isFetching}
					/>

					{campaignsQuery.isError && (
						<Alert
							type="error"
							showIcon
							className="mb-6 rounded-2xl"
							message="Kampaniyalarni yuklab bo'lmadi"
							description={getApiErrorMessage(campaignsQuery.error, "Server bilan aloqa yo'q")}
							action={
								<Button size="small" onClick={() => campaignsQuery.refetch()}>
									Qayta urinish
								</Button>
							}
						/>
					)}

					<CampaignsTable
						campaigns={campaigns}
						progressMap={progressMap}
						meta={campaignsQuery.data?.data.meta}
						isLoading={campaignsQuery.isLoading}
						canManage={canManage}
						isMutating={
							pauseCampaign.isPending || cancelCampaign.isPending || removeCampaign.isPending
						}
						onPageChange={(page, limit) => setFilters((current) => ({ ...current, page, limit }))}
						onStart={setStarting}
						onPause={(campaign) => pauseCampaign.mutate(campaign.id)}
						onCancel={(campaign) => cancelCampaign.mutate(campaign.id)}
						onEdit={openEdit}
						onDelete={(campaign) => removeCampaign.mutate(campaign.id)}
					/>
				</>
			)}

			<CampaignFormModal
				open={isFormOpen}
				campaign={editing}
				onClose={() => setIsFormOpen(false)}
			/>

			<StartCampaignModal
				open={starting !== null}
				campaign={starting}
				onClose={() => setStarting(null)}
			/>
		</div>
	);
}
