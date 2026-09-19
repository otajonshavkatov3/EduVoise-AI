import { BookOutlined, LockOutlined } from "@ant-design/icons";
import { Alert, Select, Tag } from "antd";
import { useState } from "react";
import { useActiveAgentProfile, useAgentProfiles } from "@/modules/ai-agent/hooks/useAiAgent";
import { needsProfileSetup } from "@/modules/ai-agent/utils/profileForm";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { useKnowledgeStats } from "../hooks/useKnowledgeBase";
import type { KnowledgeBaseEntry } from "../types";
import { KnowledgeBulkImport } from "./KnowledgeBulkImport";
import { KnowledgeEntriesCard } from "./KnowledgeEntriesCard";
import { KnowledgeEntryModal } from "./KnowledgeEntryModal";
import { KnowledgeTestPanel } from "./KnowledgeTestPanel";

function StatChip({ label, value }: { label: string; value: string }) {
	return (
		<span className="inline-flex items-center gap-2 rounded-xl border border-slate-100 bg-white px-3 py-2">
			<span className="text-[9px] font-black tracking-widest text-slate-400 uppercase">
				{label}
			</span>
			<span className="text-sm font-black text-slate-900">{value}</span>
		</span>
	);
}

function numberOrDash(value: number | undefined): string {
	return typeof value === "number" ? String(value) : "—";
}

/**
 * «Bilim bazasi» varag'i.
 *
 * Tepada sinov paneli turadi — bu sahifadagi eng foydali qism: AI aynan nimani
 * bilishini va nimani bilmasligini bir bosishda ko'rsatadi.
 *
 * Profil tanlagich ham shu yerda: qoralama profilning bilim bazasi API da
 * `profileId` orqali ochiq, lekin UI da yo'q edi — ya'ni qoralamani jonli
 * liniyaga chiqarishdan oldin unga savol-javob kiritib bo'lmasdi.
 */
export function KnowledgeBasePanel() {
	const user = useAuthStore((state) => state.user);
	const canEdit = user?.role === "supervisor";

	const [isModalOpen, setIsModalOpen] = useState(false);
	const [editingEntry, setEditingEntry] = useState<KnowledgeBaseEntry | null>(null);
	const [prefilledQuestion, setPrefilledQuestion] = useState<string>("");
	const [chosenProfileId, setChosenProfileId] = useState<string | null>(null);

	const activeProfileQuery = useActiveAgentProfile();
	const profilesQuery = useAgentProfiles();

	const activeProfile = activeProfileQuery.data?.data;
	const profiles = profilesQuery.data?.items ?? [];

	// Tanlangan profil o'chirilgan bo'lishi mumkin — bunday holatda aktiv profilga
	// qaytamiz, aks holda panel mavjud bo'lmagan profil bo'yicha so'rov yuborardi.
	const selectedId =
		chosenProfileId && profiles.some((item) => item.id === chosenProfileId)
			? chosenProfileId
			: (activeProfile?.id ?? undefined);

	const selectedProfile = profiles.find((item) => item.id === selectedId);
	const isDraftSelected = selectedProfile ? !selectedProfile.isActive : false;
	const headerName = selectedProfile?.businessName ?? activeProfile?.businessName ?? "Bilim bazasi";

	const statsQuery = useKnowledgeStats(selectedId);
	const stats = statsQuery.data;

	const openCreate = (question = "") => {
		setEditingEntry(null);
		setPrefilledQuestion(question);
		setIsModalOpen(true);
	};

	const openEdit = (entry: KnowledgeBaseEntry) => {
		setEditingEntry(entry);
		setPrefilledQuestion("");
		setIsModalOpen(true);
	};

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
				<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
					<BookOutlined />
				</div>
				<div className="min-w-0">
					<div className="text-sm font-black text-slate-900">{headerName}</div>
					<div className="text-xs font-medium text-slate-500">
						AI faqat shu yozuvlardagi ma'lumotni aytadi — qolgan hamma savolda profildagi qoida
						ishlaydi
					</div>
				</div>

				<div className="ml-auto flex flex-wrap items-center gap-2">
					{profiles.length > 1 && (
						<Select
							value={selectedId}
							onChange={(next: string) => setChosenProfileId(next)}
							options={profiles.map((item) => ({
								value: item.id,
								label: item.isActive ? `${item.businessName} (faol)` : item.businessName,
							}))}
							loading={profilesQuery.isLoading}
							className="custom-select w-56"
						/>
					)}
					<StatChip label="Jami" value={numberOrDash(stats?.total)} />
					<StatChip label="Yoqilgan" value={numberOrDash(stats?.active)} />
					<StatChip label="Ishlatilgan" value={numberOrDash(stats?.totalUses)} />
					<StatChip label="Ishlatilmagan" value={numberOrDash(stats?.neverUsed)} />
					{!canEdit && (
						<span className="inline-flex items-center gap-2 rounded-xl border border-slate-100 bg-white px-3 py-2 text-xs font-bold text-slate-500">
							<LockOutlined />
							Faqat ko'rish
						</span>
					)}
				</div>
			</div>

			{isDraftSelected && (
				<Alert
					type="info"
					showIcon
					className="rounded-2xl border-blue-100 bg-blue-50"
					title={
						<span className="font-bold text-blue-600">
							Qoralama profil bilim bazasi
							<Tag
								color="default"
								className="ml-2 m-0 rounded-lg border-none text-[10px] font-bold"
							>
								Qoralama
							</Tag>
						</span>
					}
					description={
						<span className="text-slate-600">
							Bu yozuvlar jonli qo'ng'iroqlarda ishlatilmaydi. «Biznes profili» bo'limida shu
							profilni faollashtirsangiz — AI shu bazadan javob bera boshlaydi.
						</span>
					}
				/>
			)}

			{activeProfile && needsProfileSetup(activeProfile) && (
				<Alert
					type="warning"
					showIcon
					className="rounded-2xl border-amber-200 bg-amber-50"
					title={
						<span className="font-bold text-amber-600">
							Biznes profili to'ldirilmagan — avval «Biznes profili» bo'limini to'ldiring
						</span>
					}
					description={
						<span className="text-slate-600">
							Bilim bazasi faol profilga bog'lanadi. Profil sozlanmagan bo'lsa yozuvlar standart
							profilga tushadi.
						</span>
					}
				/>
			)}

			{/* `key` — profil almashganda oldingi profilning qidiruv natijasi va
			    filtrlari ekranda qolib ketmasligi uchun. */}
			<KnowledgeTestPanel
				key={`test-${selectedId ?? "active"}`}
				onAddEntry={(question) => openCreate(question)}
				canEdit={canEdit}
				profileId={selectedId}
			/>

			<KnowledgeEntriesCard
				key={`entries-${selectedId ?? "active"}`}
				canEdit={canEdit}
				onCreate={() => openCreate()}
				onEdit={openEdit}
				profileId={selectedId}
			/>

			{canEdit && <KnowledgeBulkImport profileId={selectedId} />}

			<KnowledgeEntryModal
				open={isModalOpen}
				entry={editingEntry}
				defaultQuestion={prefilledQuestion}
				profileId={selectedId}
				onClose={() => {
					setIsModalOpen(false);
					setEditingEntry(null);
					setPrefilledQuestion("");
				}}
			/>
		</div>
	);
}
