import { DeleteOutlined, PlusOutlined, SearchOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Empty, Input, Popconfirm, Select, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useDebouncedCallback } from "@/shared/hooks/useDebouncedCallback";
import { formatDateTime } from "@/shared/utils/datetime";
import { useAddDnc, useDncList, useRemoveDnc } from "../hooks/useCampaigns";
import type { DncCreateResult, DncEntry, DncListFilters, DncSource } from "../types";
import { DNC_SOURCE_COLORS, DNC_SOURCE_LABELS, optionsFrom } from "../utils/labels";

interface Props {
	canManage: boolean;
	canDelete: boolean;
}

const SOURCE_OPTIONS = optionsFrom(DNC_SOURCE_LABELS);

/**
 * One box, one number per line - or several separated by commas.
 *
 * The endpoint takes an array, and the split happens here rather than on the
 * server because the server must not have to guess whether "998901234567,998.."
 * is one malformed number or two good ones.
 */
function splitPhones(text: string): string[] {
	return text
		.split(/[\n,;]+/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function ResultSummary({ result }: { result: DncCreateResult }) {
	const parts: string[] = [];

	if (result.created > 0) {
		parts.push(`${result.created} ta raqam qo'shildi`);
	}
	if (result.existing > 0) {
		parts.push(`${result.existing} tasi allaqachon ro'yxatda edi`);
	}
	if (result.failed > 0) {
		parts.push(`${result.failed} tasi qabul qilinmadi`);
	}
	if (result.leadsSkipped > 0) {
		parts.push(`${result.leadsSkipped} ta kampaniya yozuvi navbatdan chiqarildi`);
	}

	return (
		<Alert
			type={result.created > 0 ? "success" : "warning"}
			showIcon
			className="mt-4 rounded-xl"
			message={parts.join(", ")}
			description={
				result.results.some((row) => row.message !== null) ? (
					<ul className="m-0 list-disc space-y-1 pl-4 text-slate-600">
						{result.results
							.filter((row) => row.message !== null)
							.map((row) => (
								<li key={`${row.index}-${row.input}`}>
									<span className="font-mono text-[11px] text-slate-400">{row.input}</span> —{" "}
									{row.message}
								</li>
							))}
					</ul>
				) : null
			}
		/>
	);
}

/**
 * The list a person gets onto by asking.
 *
 * `asked_on_call` entries are written by the agent during a call, and they are
 * the ones that may never be deleted - a promise that can be undone by whoever
 * finds the row inconvenient is not a promise. Rows typed in by hand can be
 * wrong (a mistyped digit blocks a stranger), so those an admin may remove.
 */
export function DoNotCallPanel({ canManage, canDelete }: Props) {
	const [filters, setFilters] = useState<DncListFilters>({ page: 1, limit: 20 });
	const [phonesText, setPhonesText] = useState("");
	const [reason, setReason] = useState("");
	const [result, setResult] = useState<DncCreateResult | null>(null);

	const dncQuery = useDncList(filters);
	const addDnc = useAddDnc();
	const removeDnc = useRemoveDnc();

	const handleSearch = useDebouncedCallback((value: string) =>
		setFilters((current) => ({ ...current, q: value, page: 1 }))
	);

	const phones = splitPhones(phonesText);

	const handleAdd = async () => {
		if (phones.length === 0) {
			return;
		}

		try {
			const response = await addDnc.mutateAsync({
				phones,
				reason: reason.trim().length > 0 ? reason.trim() : undefined,
			});

			setResult(response);

			if (response.created > 0) {
				setPhonesText("");
				setReason("");
			}
		} catch {
			// Sabab hook'dagi toast'da.
		}
	};

	const columns: ColumnsType<DncEntry> = [
		{
			title: "Raqam",
			key: "phone",
			width: 200,
			render: (_, row) => (
				<span className="font-mono font-bold text-slate-900">{row.phoneDisplay}</span>
			),
		},
		{
			title: "Qanday kiritilgan",
			key: "source",
			width: 190,
			render: (_, row) => (
				<div className="flex flex-col gap-1">
					<Tag
						color={DNC_SOURCE_COLORS[row.source]}
						className="m-0 w-fit rounded-md border-none text-[11px] font-bold"
					>
						{row.sourceLabel}
					</Tag>
					{row.callId !== null && (
						<Link
							to={`/calls/${row.callId}`}
							className="text-[11px] font-bold text-blue-600 hover:underline"
						>
							Qo'ng'iroqni ochish
						</Link>
					)}
				</div>
			),
		},
		{
			title: "Sabab",
			key: "reason",
			render: (_, row) =>
				row.reason === null ? (
					<span className="text-[11px] text-slate-300 italic">Sabab yozilmagan</span>
				) : (
					<span className="text-xs font-medium text-slate-600">{row.reason}</span>
				),
		},
		{
			title: "Kim / qachon",
			key: "created",
			width: 200,
			render: (_, row) => (
				<div className="flex flex-col">
					<span className="text-xs font-medium text-slate-600">
						{row.createdByName ?? "AI (qo'ng'iroq vaqtida)"}
					</span>
					<span className="text-[10px] text-slate-400">{formatDateTime(row.createdAt)}</span>
				</div>
			),
		},
		{
			title: "",
			key: "actions",
			width: 60,
			align: "right",
			render: (_, row) => {
				if (!(canDelete && row.removable)) {
					return (
						<Tooltip
							title={
								row.removable
									? "O'chirish faqat administrator uchun"
									: "Odam qo'ng'iroq vaqtida o'zi so'ragan — bu yozuv o'chirilmaydi"
							}
						>
							<StopOutlined className="text-slate-300" />
						</Tooltip>
					);
				}

				return (
					<Popconfirm
						title="Yozuvni o'chirish"
						description="Raqam yana kampaniyalarga qo'shilishi mumkin bo'lib qoladi."
						okText="O'chirish"
						cancelText="Yo'q"
						okButtonProps={{ danger: true, loading: removeDnc.isPending }}
						onConfirm={() => removeDnc.mutate(row.id)}
					>
						<Button type="text" icon={<DeleteOutlined className="text-rose-500" />} />
					</Popconfirm>
				);
			},
		},
	];

	return (
		<div>
			<Alert
				type="info"
				showIcon
				className="mb-6 rounded-2xl"
				message="Har bir qo'ng'iroq shu ro'yxatdan o'tadi"
				description="Odam suhbat vaqtida «boshqa qo'ng'iroq qilmang» desa, AI raqamni shu yerga o'zi yozadi va u raqam hech qaysi kampaniyada terilmaydi. Qo'lda ham qo'shish mumkin."
			/>

			{canManage && (
				<Card className="mb-6 rounded-2xl border-none shadow-sm">
					<div className="mb-3 flex items-center gap-3">
						<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-50 text-rose-500">
							<StopOutlined />
						</div>
						<div>
							<div className="text-sm leading-none font-black text-slate-900">
								Qo'lda raqam qo'shish
							</div>
							<div className="text-[9px] font-bold tracking-widest text-slate-400 uppercase">
								Har qatorga bitta raqam — yoki vergul bilan
							</div>
						</div>
					</div>

					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						<Input.TextArea
							rows={3}
							value={phonesText}
							onChange={(event) => setPhonesText(event.target.value)}
							placeholder={"998901234567\n+998 90 570 65 07"}
							className="rounded-xl font-mono text-xs"
						/>
						<Input.TextArea
							rows={3}
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder="Sabab (ixtiyoriy) — masalan: mijoz so'radi"
							className="rounded-xl"
						/>
					</div>

					<Button
						type="primary"
						danger
						icon={<PlusOutlined />}
						loading={addDnc.isPending}
						disabled={phones.length === 0}
						onClick={handleAdd}
						className="mt-3 h-11 rounded-xl px-6 font-bold"
					>
						{phones.length > 1 ? `${phones.length} ta raqamni qo'shish` : "Ro'yxatga qo'shish"}
					</Button>

					{result !== null && <ResultSummary result={result} />}
				</Card>
			)}

			<Card className="mb-4 rounded-2xl border-none shadow-sm">
				<div className="flex flex-wrap items-center gap-3">
					<Input
						allowClear
						prefix={<SearchOutlined className="text-slate-400" />}
						placeholder="Raqam bo'yicha izlash"
						onChange={(event) => handleSearch(event.target.value)}
						className="h-11 w-full rounded-xl md:w-72"
					/>
					<Select<DncSource>
						allowClear
						placeholder="Qanday kiritilgan"
						value={filters.source}
						options={SOURCE_OPTIONS}
						onChange={(value) => setFilters((current) => ({ ...current, source: value, page: 1 }))}
						className="h-11 w-full md:w-56"
					/>
				</div>
			</Card>

			<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
				<Table<DncEntry>
					columns={columns}
					dataSource={dncQuery.data?.data.items ?? []}
					loading={dncQuery.isLoading}
					rowKey="id"
					size="middle"
					scroll={{ x: 860 }}
					pagination={{
						current: dncQuery.data?.data.meta.page,
						pageSize: dncQuery.data?.data.meta.limit,
						total: dncQuery.data?.data.meta.total,
						showSizeChanger: true,
						showTotal: (total, range) => `${range[0]}–${range[1]} / jami ${total}`,
						className: "px-6 pb-4",
						onChange: (page, limit) => setFilters((current) => ({ ...current, page, limit })),
					}}
					locale={{
						emptyText: (
							<Empty
								className="py-12"
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description="Ro'yxat bo'sh — hali hech kim qo'ng'iroq qilinmasin demagan"
							/>
						),
					}}
				/>
			</Card>
		</div>
	);
}
