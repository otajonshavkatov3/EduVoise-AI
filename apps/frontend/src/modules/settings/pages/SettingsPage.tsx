import { LockOutlined, ReloadOutlined, SettingOutlined } from "@ant-design/icons";
import type { UserRoleType } from "@shared/types";
import { Alert, Button, Card, Skeleton, Tabs } from "antd";
import { useState } from "react";

import { useAuthStore } from "@/modules/auth/store/auth.store";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { SettingsSectionCard } from "../components/SettingsSectionCard";
import { SipDeviceSettings } from "../components/SipDeviceSettings";
import { TelegramTestPanel } from "../components/TelegramTestPanel";
import { useSettings } from "../hooks/useSettings";
import type { SettingCategory } from "../types";

/**
 * Every tab except "telephony" is backed by the settings registry on the backend
 * (GET/PATCH /api/settings). "telephony" is the browser's own SIP account, which
 * is per-device and never leaves this machine.
 */
type TabKey = SettingCategory | "telephony";

/**
 * The rate rows are the same data as the AI cost page, so they carry the same
 * roles: the backend omits the "pricing" category for everyone else (see
 * CATEGORY_VIEW_ROLES in settings.handlers.ts). Without this filter a manager
 * would open the tab onto "Bu bo'lim uchun hozircha sozlama ro'yxatga olinmagan",
 * which would be a lie: the rows exist, this role may not see them.
 */
const PRICING_VIEW_ROLES: UserRoleType[] = ["supervisor", "admin"];

const TABS: { key: TabKey; label: string; roles?: UserRoleType[] }[] = [
	{ key: "general", label: "Umumiy" },
	{ key: "telephony", label: "Telefoniya" },
	{ key: "pricing", label: "Narxlar", roles: PRICING_VIEW_ROLES },
	{ key: "notifications", label: "Bildirishnomalar" },
];

export default function SettingsPage() {
	const [activeTab, setActiveTab] = useState<TabKey>("general");
	const settingsQuery = useSettings();
	const user = useAuthStore((state) => state.user);
	const visibleTabs = TABS.filter(
		(tab) => !tab.roles || (user !== null && tab.roles.includes(user.role))
	);

	const payload = settingsQuery.data?.data;
	const canEdit = payload?.canEdit === true;
	const group =
		activeTab === "telephony"
			? undefined
			: payload?.categories.find((item) => item.category === activeTab);

	return (
		<div className="animate-fadeIn">
			{/* Page Header */}
			<div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-center">
				<div>
					<h1 className="flex items-center gap-3 text-3xl font-black tracking-tight text-slate-900">
						<SettingOutlined className="text-blue-600" />
						Sozlamalar
					</h1>
					<p className="font-medium text-slate-500">
						Tizim sozlamalari serverda saqlanadi va backend restartidan keyin ham saqlanib qoladi
					</p>
				</div>
				{payload && !canEdit && (
					<div className="flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-500">
						<LockOutlined />
						Faqat ko'rish rejimi
					</div>
				)}
			</div>

			<Tabs
				activeKey={activeTab}
				onChange={(key) => setActiveTab(key as TabKey)}
				className="custom-segmented-tabs"
				items={visibleTabs.map((tab) => ({ key: tab.key, label: tab.label }))}
			/>

			{activeTab === "telephony" && <SipDeviceSettings />}

			{activeTab !== "telephony" && settingsQuery.isLoading && (
				<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
					<Skeleton active paragraph={{ rows: 6 }} />
				</Card>
			)}

			{activeTab !== "telephony" && settingsQuery.isError && (
				<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
					<Alert
						type="error"
						showIcon
						className="rounded-xl border-rose-200 bg-rose-50"
						title={
							<span className="font-bold text-rose-600">
								{getApiErrorMessage(settingsQuery.error, "Sozlamalarni yuklab bo'lmadi")}
							</span>
						}
					/>
					<Button
						icon={<ReloadOutlined />}
						onClick={() => {
							settingsQuery.refetch();
						}}
						className="mt-4 h-11 rounded-xl px-6 font-bold"
					>
						Qayta urinish
					</Button>
				</Card>
			)}

			{activeTab !== "telephony" &&
				!settingsQuery.isLoading &&
				!settingsQuery.isError &&
				!group && (
					<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
						<Alert
							type="info"
							showIcon
							className="rounded-xl border-blue-100 bg-blue-50"
							title={
								<span className="font-bold text-blue-600">
									Bu bo'lim uchun hozircha sozlama ro'yxatga olinmagan
								</span>
							}
						/>
					</Card>
				)}

			{group && (
				<SettingsSectionCard
					key={group.category}
					group={group}
					canEdit={canEdit}
					renderExtra={(draft) => {
						if (group.category === "notifications") {
							return <TelegramTestPanel draft={draft} canEdit={canEdit} />;
						}
						return null;
					}}
				/>
			)}
		</div>
	);
}
