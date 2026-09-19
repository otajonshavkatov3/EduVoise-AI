import { DatabaseOutlined, PlusOutlined, ReloadOutlined, TagOutlined } from "@ant-design/icons";
import {
	Alert,
	App,
	Button,
	Card,
	Empty,
	Input,
	Popconfirm,
	Select,
	Switch,
	Table,
	Tag,
} from "antd";
import { useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import {
	useDeleteKnowledgeEntry,
	useKnowledgeEntries,
	useUpdateKnowledgeEntry,
} from "../hooks/useKnowledgeBase";
import type { KnowledgeBaseEntry, KnowledgeBaseFilters } from "../types";

interface Props {
	canEdit: boolean;
	onCreate: () => void;
	onEdit: (entry: KnowledgeBaseEntry) => void;
	/** Berilmasa aktiv profil yozuvlari ko'rsatiladi. */
	profileId?: string;
}

const INITIAL_FILTERS: KnowledgeBaseFilters = { page: 1, limit: 20 };

const ACTIVE_OPTIONS = [
	{ value: "all", label: "Barchasi" },
	{ value: "true", label: "Faqat yoqilgan" },
	{ value: "false", label: "Faqat o'chirilgan" },
];

function formatDate(value: string | null): string {
	if (!value) {
		return "Hech qachon";
	}

	const date = new Date(value);

	if (Number.isNaN(date.getTime())) {
		return "—";
	}

	return `${date.toLocaleDateString("uz-UZ")} ${date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	})}`;
}

/** Bilim bazasi yozuvlari jadvali: qidirish, yoqib-o'chirish, tahrirlash. */
export function KnowledgeEntriesCard({ canEdit, onCreate, onEdit, profileId }: Props) {
	const { message } = App.useApp();
	const [filters, setFilters] = useState<KnowledgeBaseFilters>(INITIAL_FILTERS);
	const [searchDraft, setSearchDraft] = useState("");
	const [tagDraft, setTagDraft] = useState("");
	// Bitta mutatsiya butun jadval uchun umumiy, shuning uchun "qaysi qator
	// saqlanmoqda" alohida kuzatiladi — aks holda bitta switch bosilganda hamma
	// qatorlar birdan o'chib qolardi.
	const [togglingId, setTogglingId] = useState<string | null>(null);

	const entriesQuery = useKnowledgeEntries({ ...filters, profileId });
	const updateEntry = useUpdateKnowledgeEntry();
	const deleteEntry = useDeleteKnowledgeEntry();

	const entries = entriesQuery.data?.items ?? [];
	const meta = entriesQuery.data?.meta;

	const applySearch = (value: string) => {
		const next = value.trim() || undefined;
		setFilters((current) => (current.q === next ? current : { ...current, page: 1, q: next }));
	};

	// Faqat haqiqatan o'zgarganda yangilanadi: aks holda teg maydonidan chiqishning
	// o'zi sahifalashni birinchi sahifaga tashlab yuborardi.
	const applyTag = (value: string) => {
		const next = value.trim() || undefined;
		setFilters((current) => (current.tag === next ? current : { ...current, page: 1, tag: next }));
	};

	const toggleActive = async (entry: KnowledgeBaseEntry, isActive: boolean) => {
		setTogglingId(entry.id);

		try {
			await updateEntry.mutateAsync({ id: entry.id, data: { isActive } });
			message.success(isActive ? "Yozuv yoqildi" : "Yozuv o'chirildi — AI uni endi ko'rmaydi");
		} catch {
			// Xato hook ichida ko'rsatiladi
		} finally {
			setTogglingId(null);
		}
	};

	const columns = [
		{
			title: "Savol va javob",
			key: "question",
			render: (_: unknown, record: KnowledgeBaseEntry) => (
				<div className="flex max-w-xl flex-col">
					<span className="text-sm font-bold text-slate-900">{record.question}</span>
					<span className="text-[11px] font-medium text-slate-500">
						{record.answer.length > 120 ? `${record.answer.slice(0, 120)}...` : record.answer}
					</span>
				</div>
			),
		},
		{
			title: "Teglar",
			key: "tags",
			render: (_: unknown, record: KnowledgeBaseEntry) =>
				record.tags.length === 0 ? (
					<span className="text-xs text-slate-300">—</span>
				) : (
					<div className="flex max-w-[180px] flex-wrap gap-1">
						{record.tags.map((tag) => (
							// Tegni bosish — o'sha teg bo'yicha filtrlash: 55 ta yozuvda
							// kerakli mavzuni topishning eng tez yo'li.
							<Tag
								key={tag}
								onClick={() => {
									setTagDraft(tag);
									applyTag(tag);
								}}
								className="m-0 cursor-pointer rounded-lg border-none text-[10px] font-bold"
							>
								{tag}
							</Tag>
						))}
					</div>
				),
		},
		{
			title: "Ustuvorlik",
			key: "priority",
			width: 110,
			render: (_: unknown, record: KnowledgeBaseEntry) => (
				<span
					className={`text-xs font-black ${
						record.priority > 0 ? "text-amber-600" : "text-slate-500"
					}`}
				>
					{record.priority}
				</span>
			),
		},
		{
			title: "Ishlatilgan",
			key: "useCount",
			width: 150,
			render: (_: unknown, record: KnowledgeBaseEntry) => (
				<div className="flex flex-col">
					<span className="text-xs font-bold text-slate-700">{record.useCount} marta</span>
					<span className="text-[10px] text-slate-400">{formatDate(record.lastUsedAt)}</span>
				</div>
			),
		},
		{
			title: "Yoqilgan",
			key: "isActive",
			width: 110,
			render: (_: unknown, record: KnowledgeBaseEntry) => (
				<Switch
					size="small"
					checked={record.isActive}
					disabled={!canEdit || togglingId === record.id}
					loading={togglingId === record.id}
					onChange={(checked) => toggleActive(record, checked)}
				/>
			),
		},
		{
			title: "Amallar",
			key: "actions",
			width: 190,
			render: (_: unknown, record: KnowledgeBaseEntry) => {
				if (!canEdit) {
					return <span className="text-xs italic text-slate-400">—</span>;
				}

				return (
					<div className="flex flex-wrap gap-2">
						<Button size="small" onClick={() => onEdit(record)} className="rounded-xl font-bold">
							Tahrirlash
						</Button>
						<Popconfirm
							title="Yozuv o'chirilsinmi?"
							description="AI bu javobni boshqa aytmaydi. Vaqtincha to'xtatish uchun «Yoqilgan» ni o'chirish yetarli."
							okText="O'chirish"
							cancelText="Bekor"
							okButtonProps={{ danger: true }}
							onConfirm={() => deleteEntry.mutate(record.id)}
						>
							<Button size="small" danger className="rounded-xl font-bold">
								O'chirish
							</Button>
						</Popconfirm>
					</div>
				);
			},
		},
	];

	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<div className="flex items-center gap-3">
					<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
						<DatabaseOutlined />
					</div>
					<div>
						<div className="mb-1 text-sm leading-none font-black text-slate-900">Yozuvlar</div>
						<div className="text-[9px] leading-none font-bold tracking-widest text-slate-400 uppercase">
							AI faqat shu javoblarni aytishga haqli
						</div>
					</div>
				</div>
			}
			extra={
				<div className="flex gap-2">
					<Button
						icon={<ReloadOutlined />}
						loading={entriesQuery.isFetching}
						onClick={() => {
							entriesQuery.refetch();
						}}
						className="h-10 rounded-xl px-4 font-bold"
					>
						Yangilash
					</Button>
					{canEdit && (
						<Button
							type="primary"
							icon={<PlusOutlined />}
							onClick={onCreate}
							className="h-10 rounded-xl px-4 font-bold shadow-lg shadow-blue-500/20"
						>
							Yangi yozuv
						</Button>
					)}
				</div>
			}
		>
			<div className="mb-4 flex flex-col gap-3 md:flex-row">
				<Input.Search
					value={searchDraft}
					onChange={(event) => setSearchDraft(event.target.value)}
					onSearch={applySearch}
					allowClear
					placeholder="Savol yoki javob matni bo'yicha qidirish"
					className="md:max-w-md"
				/>
				<Input
					value={tagDraft}
					onChange={(event) => setTagDraft(event.target.value)}
					onPressEnter={() => applyTag(tagDraft)}
					onBlur={() => applyTag(tagDraft)}
					allowClear
					onClear={() => applyTag("")}
					prefix={<TagOutlined className="text-slate-400" />}
					placeholder="Teg bo'yicha"
					className="h-10 rounded-xl border-slate-200 bg-slate-50 md:w-48"
				/>
				<Select
					value={filters.isActive ?? "all"}
					onChange={(value) =>
						setFilters((current) => ({
							...current,
							page: 1,
							isActive: value === "all" ? undefined : (value as "true" | "false"),
						}))
					}
					options={ACTIVE_OPTIONS}
					className="custom-select md:w-48"
				/>
				<Button
					onClick={() => {
						setSearchDraft("");
						setTagDraft("");
						setFilters(INITIAL_FILTERS);
					}}
					className="h-10 rounded-xl px-4 font-bold"
				>
					Tozalash
				</Button>
			</div>

			{entriesQuery.isError && (
				<Alert
					type="error"
					showIcon
					className="mb-4 rounded-xl border-rose-200 bg-rose-50"
					title={
						<span className="font-bold text-rose-600">
							{getApiErrorMessage(entriesQuery.error, "Yozuvlarni yuklab bo'lmadi")}
						</span>
					}
				/>
			)}

			<Table
				columns={columns}
				dataSource={entries}
				loading={entriesQuery.isLoading}
				rowKey="id"
				size="small"
				scroll={{ x: 1000 }}
				rowClassName={(record) => (record.isActive ? "" : "opacity-60")}
				locale={{
					emptyText: (
						<Empty
							className="py-10"
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description={
								<div className="space-y-1">
									<div className="font-bold text-slate-600">Bilim bazasi bo'sh</div>
									<div className="text-xs text-slate-400">
										AI hozir biznes haqidagi savollarga javob bermaydi — profildagi qoida ishlaydi.
									</div>
								</div>
							}
						/>
					),
				}}
				pagination={
					meta
						? {
								current: meta.page,
								pageSize: meta.limit,
								total: meta.total,
								showSizeChanger: true,
								className: "px-2 pb-2",
								onChange: (page, limit) => setFilters((current) => ({ ...current, page, limit })),
							}
						: false
				}
			/>
		</Card>
	);
}
