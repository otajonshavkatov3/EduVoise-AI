import { RobotOutlined } from "@ant-design/icons";
import { Tabs } from "antd";
import { useState } from "react";
import { AgentProfilePanel } from "@/modules/ai-agent/components/AgentProfilePanel";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { KnowledgeBasePanel } from "@/modules/knowledge-base/components/KnowledgeBasePanel";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { AiConfigForm } from "../components/AiConfigForm";
import { EffectiveConfigCard } from "../components/EffectiveConfigCard";
import { ProviderStatusCard } from "../components/ProviderStatusCard";
import { SessionFilters } from "../components/SessionFilters";
import { SessionsTable } from "../components/SessionsTable";
import { useAiConfig, useAiSessions, useAiStatus } from "../hooks/useAiAssistant";
import type { AiSessionFilters } from "../types";

const DEFAULT_FILTERS: AiSessionFilters = { page: 1, limit: 20 };

export default function AiAssistantPage() {
	const user = useAuthStore((state) => state.user);
	const isSupervisor = user?.role === "supervisor";

	const [activeTab, setActiveTab] = useState("status");
	const [filters, setFilters] = useState<AiSessionFilters>(DEFAULT_FILTERS);

	/**
	 * Tabs are hidden, not unmounted, once they have been opened.
	 *
	 * Two of these tabs are long forms. Rendering only the active one destroyed all
	 * of their state on every tab switch, so filling in the business profile and
	 * glancing at the knowledge base threw the whole form away - which reads as the
	 * page refusing to keep what you typed.
	 *
	 * Only tabs that have actually been visited are mounted, so an unopened tab
	 * still costs no queries.
	 */
	const [visited, setVisited] = useState<Set<string>>(() => new Set(["status"]));

	const openTab = (key: string) => {
		setActiveTab(key);
		setVisited((current) => (current.has(key) ? current : new Set(current).add(key)));
	};

	/** Mounted but out of view - `hidden` keeps the DOM and the React state alive. */
	const paneClass = (key: string) => (activeTab === key ? "" : "hidden");

	const statusQuery = useAiStatus();
	const configQuery = useAiConfig();
	const sessionsQuery = useAiSessions(filters);

	return (
		<div className="animate-fadeIn">
			{/* Page Header */}
			<div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
				<div>
					<h1 className="flex items-center gap-3 text-3xl font-black text-slate-900 tracking-tight">
						<RobotOutlined className="text-blue-600" />
						AI yordamchi
					</h1>
					<p className="text-slate-500 font-medium">
						Ovozli AI operator holati, sozlamalari va sessiyalar tarixi
					</p>
				</div>
			</div>

			<Tabs
				activeKey={activeTab}
				onChange={openTab}
				className="custom-segmented-tabs"
				items={[
					{ key: "status", label: "Holat va sozlamalar" },
					{ key: "profile", label: "Biznes profili" },
					{ key: "knowledge", label: "Bilim bazasi" },
					{ key: "sessions", label: "Sessiyalar" },
				]}
			/>

			{visited.has("status") && (
				<div className={`space-y-6 ${paneClass("status")}`}>
					<ProviderStatusCard
						status={statusQuery.data?.data}
						isLoading={statusQuery.isLoading}
						isFetching={statusQuery.isFetching}
						isError={statusQuery.isError}
						errorMessage={
							statusQuery.isError
								? getApiErrorMessage(statusQuery.error, "Holatni olib bo'lmadi")
								: null
						}
						onRefresh={() => {
							statusQuery.refetch();
						}}
					/>

					{/*
					 * Sozlamalar shakli — sahifaning asosiy qismi, shuning uchun to'liq
					 * kenglikda. Ilgari u faqat o'qiladigan nusxa bilan yonma-yon turardi;
					 * endi har bir qiymat bitta joyda va o'sha joyda tahrirlanadi.
					 */}
					<AiConfigForm
						config={configQuery.data?.data}
						isLoading={configQuery.isLoading}
						isError={configQuery.isError}
						errorMessage={
							configQuery.isError
								? getApiErrorMessage(configQuery.error, "Konfiguratsiyani olib bo'lmadi")
								: null
						}
						isSupervisor={isSupervisor}
					/>

					<EffectiveConfigCard
						config={configQuery.data?.data}
						isLoading={configQuery.isLoading}
						isError={configQuery.isError}
						errorMessage={
							configQuery.isError
								? getApiErrorMessage(configQuery.error, "Konfiguratsiyani olib bo'lmadi")
								: null
						}
					/>
				</div>
			)}

			{visited.has("profile") && (
				<div className={paneClass("profile")}>
					<AgentProfilePanel />
				</div>
			)}

			{visited.has("knowledge") && (
				<div className={paneClass("knowledge")}>
					<KnowledgeBasePanel />
				</div>
			)}

			{visited.has("sessions") && (
				<div className={paneClass("sessions")}>
					<SessionFilters
						onFiltersChange={(next) => setFilters((current) => ({ ...current, ...next }))}
						onReset={() => setFilters(DEFAULT_FILTERS)}
					/>
					<SessionsTable
						data={sessionsQuery.data}
						isLoading={sessionsQuery.isLoading}
						isError={sessionsQuery.isError}
						errorMessage={
							sessionsQuery.isError
								? getApiErrorMessage(sessionsQuery.error, "Sessiyalarni yuklab bo'lmadi")
								: null
						}
						onPageChange={(page, limit) => setFilters((current) => ({ ...current, page, limit }))}
						onRetry={() => {
							sessionsQuery.refetch();
						}}
					/>
				</div>
			)}
		</div>
	);
}
