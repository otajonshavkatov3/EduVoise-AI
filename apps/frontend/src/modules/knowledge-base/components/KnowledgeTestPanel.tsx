import {
	ExperimentOutlined,
	PhoneOutlined,
	PlusOutlined,
	SearchOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Input, Tag } from "antd";
import { useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useKnowledgeSearch } from "../hooks/useKnowledgeBase";
import type { KnowledgeHit } from "../types";

interface Props {
	/** Topilmagan savolni darhol yozuvga aylantirish uchun. */
	onAddEntry: (question: string) => void;
	canEdit: boolean;
	/** Berilmasa aktiv profil bo'yicha qidiriladi. */
	profileId?: string;
}

/**
 * Jonli qo'ng'iroqda agent oladigan natijalar soni
 * (`call-orchestrator.ts` → KNOWLEDGE_SEARCH_LIMIT). Sinov paneli boshqa son
 * bilan qidirsa, biznes egasi telefonda bo'ladigan narsadan farqli natija
 * ko'rgan bo'lardi.
 */
const LIVE_SEARCH_LIMIT = 4;

function ScoreBar({ score, best }: { score: number; best: number }) {
	const ratio = best > 0 ? Math.max(8, Math.round((score / best) * 100)) : 0;

	return (
		<div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
			<div className="h-full rounded-full bg-blue-500" style={{ width: `${ratio}%` }} />
		</div>
	);
}

function HitCard({ hit, index, best }: { hit: KnowledgeHit; index: number; best: number }) {
	return (
		<div className="rounded-2xl border border-slate-100 bg-white p-4">
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<span className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-600 text-[11px] font-black text-white">
					{index + 1}
				</span>
				<span className="text-sm font-black text-slate-900">{hit.question}</span>
			</div>

			<p className="m-0 text-sm leading-relaxed font-medium text-slate-700">{hit.answer}</p>

			<div className="mt-3 flex flex-wrap items-center gap-2">
				<ScoreBar score={hit.score} best={best} />
				<span className="text-[10px] font-black tracking-widest text-slate-400 uppercase">
					{hit.score} ball
				</span>
				{hit.priority !== 0 && (
					<Tag color="gold" className="m-0 rounded-lg border-none text-[10px] font-bold">
						Ustuvorlik: {hit.priority}
					</Tag>
				)}
				{hit.tags.map((tag) => (
					<Tag key={tag} className="m-0 rounded-lg border-none text-[10px] font-bold">
						{tag}
					</Tag>
				))}
			</div>
		</div>
	);
}

/**
 * Sinov paneli — sahifadagi eng foydali qism.
 *
 * Mijoz beradigan savolni yozib ko'rasiz va AI aynan qanday ma'lumot olishini
 * ko'rasiz. Bo'sh natija ham javob: bu savolga AI javob bermaydi, profildagi
 * qoida ishlaydi.
 */
export function KnowledgeTestPanel({ onAddEntry, canEdit, profileId }: Props) {
	const [query, setQuery] = useState("");
	const [asked, setAsked] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const search = useKnowledgeSearch();

	const result = search.data;
	const hits = result?.hits ?? [];
	const best = hits.reduce((max, hit) => Math.max(max, hit.score), 0);

	const handleSearch = async () => {
		const trimmed = query.trim();

		if (trimmed.length === 0) {
			return;
		}

		setError(null);
		setAsked(trimmed);

		try {
			await search.mutateAsync({ query: trimmed, limit: LIVE_SEARCH_LIMIT, profileId });
		} catch (caught) {
			setError(getApiErrorMessage(caught, "Qidirib bo'lmadi"));
		}
	};

	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm ring-1 ring-blue-100"
			title={
				<div className="flex items-center gap-3">
					<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-white">
						<ExperimentOutlined />
					</div>
					<div>
						<div className="mb-1 text-sm leading-none font-black text-slate-900">
							Sinab ko'rish: AI nima biladi?
						</div>
						<div className="text-[9px] leading-none font-bold tracking-widest text-slate-400 uppercase">
							Mijozning savolini yozing — AI oladigan natijani ko'rasiz
						</div>
					</div>
				</div>
			}
		>
			<div className="flex flex-col gap-3 md:flex-row">
				<Input.TextArea
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onPressEnter={(event) => {
						event.preventDefault();
						handleSearch();
					}}
					rows={2}
					maxLength={300}
					placeholder="Masalan: tish oq qilish qancha turadi?"
					className="rounded-2xl border-slate-200 bg-slate-50"
				/>
				<Button
					type="primary"
					size="large"
					icon={<SearchOutlined />}
					loading={search.isPending}
					disabled={query.trim().length === 0}
					onClick={handleSearch}
					className="h-14 shrink-0 rounded-2xl px-8 font-bold shadow-lg shadow-blue-500/20"
				>
					Sinab ko'rish
				</Button>
			</div>

			<div className="mt-2 text-xs font-medium text-slate-400">
				Qidiruv AI ishlatadigan aynan o'sha algoritm va aynan o'sha chegara ({LIVE_SEARCH_LIMIT} ta
				natija): 3 harfdan qisqa so'zlar va «qanday», «nima» kabi umumiy so'zlar hisobga olinmaydi.
			</div>

			{error && (
				<Alert
					type="error"
					showIcon
					className="mt-4 rounded-xl border-rose-200 bg-rose-50"
					title={<span className="font-bold text-rose-600">{error}</span>}
				/>
			)}

			{!error && asked !== null && !search.isPending && hits.length > 0 && (
				<div className="mt-4 space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<Tag color="green" className="m-0 rounded-lg border-none text-[11px] font-bold">
							{result?.hitCount ?? hits.length} ta javob topildi
						</Tag>
						<span className="text-xs font-medium text-slate-500">
							{result?.businessName
								? `«${result.businessName}» nomidan AI shu javoblardan foydalanadi va boshqa hech narsa qo'shmaydi.`
								: "AI shu javoblardan foydalanadi va boshqa hech narsa qo'shmaydi."}
						</span>
					</div>

					{hits.map((hit, index) => (
						<HitCard key={hit.id} hit={hit} index={index} best={best} />
					))}
				</div>
			)}

			{!error && asked !== null && !search.isPending && hits.length === 0 && (
				<Alert
					type="warning"
					showIcon
					icon={<WarningOutlined className="text-amber-500" />}
					className="mt-4 rounded-2xl border-amber-200 bg-amber-50"
					title={
						<span className="font-bold text-amber-600">
							Hech narsa topilmadi — AI bu savolga javob bermaydi
						</span>
					}
					description={
						<div className="space-y-3">
							{/* Xulosa serverdan keladi: qidiruv aynan qaysi profil bo'yicha
							    ketgan bo'lsa, o'sha profilning qoidasi qaytariladi. */}
							<div className="flex items-start gap-2 text-slate-600">
								<PhoneOutlined className="mt-1 text-slate-400" />
								<span>{result?.fallbackAction || "AI bu savolga javob bermaydi."}</span>
							</div>
							{canEdit && (
								<Button
									icon={<PlusOutlined />}
									onClick={() => onAddEntry(asked)}
									className="h-10 rounded-xl px-4 font-bold"
								>
									Shu savolga javob qo'shish
								</Button>
							)}
						</div>
					}
				/>
			)}
		</Card>
	);
}
