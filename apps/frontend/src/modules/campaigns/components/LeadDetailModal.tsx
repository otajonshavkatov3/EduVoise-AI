import { HistoryOutlined, PhoneOutlined, SaveOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Modal, Select, Skeleton, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatDateTime, formatDuration } from "@/shared/utils/datetime";
import { useCampaignLead, useUpdateLead } from "../hooks/useCampaigns";
import type { CampaignLead, CampaignOutcome, LeadAttempt } from "../types";
import {
	LEAD_STATUS_COLORS,
	LEAD_STATUS_LABELS,
	OUTCOME_COLORS,
	OUTCOME_LABELS,
	optionsFrom,
} from "../utils/labels";

interface Props {
	open: boolean;
	campaignId: string;
	lead: CampaignLead | null;
	canManage: boolean;
	onClose: () => void;
}

const OUTCOME_OPTIONS = optionsFrom(OUTCOME_LABELS);

const ATTEMPT_COLUMNS: ColumnsType<LeadAttempt> = [
	{
		title: "#",
		key: "no",
		width: 50,
		render: (_, row) => (
			<span className="font-mono text-[11px] font-bold text-slate-400">{row.attemptNo}</span>
		),
	},
	{
		title: "Terilgan vaqt",
		key: "dialedAt",
		width: 150,
		render: (_, row) => (
			<span className="text-xs font-medium text-slate-600">{formatDateTime(row.dialedAt)}</span>
		),
	},
	{
		title: "Davomiyligi",
		key: "duration",
		width: 110,
		render: (_, row) => (
			<span className="text-xs font-bold text-slate-700 tabular-nums">
				{formatDuration(row.callDuration)}
			</span>
		),
	},
	{
		title: "Natija",
		key: "outcome",
		width: 180,
		render: (_, row) =>
			row.outcome === null ? (
				<span className="text-[11px] text-slate-300">—</span>
			) : (
				<Tag color={OUTCOME_COLORS[row.outcome]} className="m-0 rounded-md border-none font-bold">
					{OUTCOME_LABELS[row.outcome]}
				</Tag>
			),
	},
	{
		title: "Qo'ng'iroq",
		key: "call",
		width: 150,
		render: (_, row) =>
			row.callId === null ? (
				<span className="text-[11px] text-slate-300">Qo'ng'iroq yozuvi yo'q</span>
			) : (
				<Link
					to={`/calls/${row.callId}`}
					className="flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
				>
					<PhoneOutlined /> Transkript, ovoz, narx
				</Link>
			),
	},
	{
		title: "Izoh",
		key: "detail",
		render: (_, row) => (
			<span className="text-[11px] font-medium text-slate-500">{row.detail ?? "—"}</span>
		),
	},
];

/** Kim, qaysi holatda, nechta urinish — va ro'yxatdan kelgan qiymatlar. */
function LeadSummary({ lead }: { lead: CampaignLead }) {
	const variables = Object.entries(lead.variables);

	return (
		<>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Tag
					color={LEAD_STATUS_COLORS[lead.status]}
					className="m-0 rounded-md border-none font-bold"
				>
					{LEAD_STATUS_LABELS[lead.status]}
				</Tag>
				{lead.outcome !== null && (
					<Tag
						color={OUTCOME_COLORS[lead.outcome]}
						className="m-0 rounded-md border-none font-bold"
					>
						{OUTCOME_LABELS[lead.outcome]}
					</Tag>
				)}
				<span className="text-xs font-medium text-slate-500">
					{lead.fullName ?? "Ismi yo'q"} · {lead.attempts} ta urinish
				</span>
				{lead.contactId !== null && (
					<Link
						to={`/contacts/${lead.contactId}`}
						className="text-xs font-bold text-blue-600 hover:underline"
					>
						Kontakt kartasi
					</Link>
				)}
			</div>

			{variables.length > 0 && (
				<div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
					<div className="mb-2 text-[9px] font-bold tracking-widest text-slate-400 uppercase">
						Ro'yxatdan olingan qiymatlar — AI shu ma'lumotlarni suhbatda ishlatadi
					</div>
					<div className="flex flex-wrap gap-2">
						{variables.map(([key, value]) => (
							<Tag key={key} className="m-0 rounded-lg border-none text-[11px] font-bold">
								{key}: {value}
							</Tag>
						))}
					</div>
				</div>
			)}
		</>
	);
}

/**
 * Writing a note, or an outcome an operator produced by ringing the person back
 * themselves. The attempt count is deliberately left alone: nobody dialled from
 * here, so the campaign's own retry budget must not be spent by a typed answer.
 */
function LeadEditor({ campaignId, lead }: { campaignId: string; lead: CampaignLead }) {
	const updateLead = useUpdateLead();
	const [note, setNote] = useState(lead.note ?? "");
	const [outcome, setOutcome] = useState<CampaignOutcome | undefined>(lead.outcome ?? undefined);

	// The row in the table is a snapshot, so the fields follow whichever lead the
	// modal was opened with rather than keeping the previous one's text.
	useEffect(() => {
		setNote(lead.note ?? "");
		setOutcome(lead.outcome ?? undefined);
	}, [lead]);

	const isDirty = note !== (lead.note ?? "") || outcome !== (lead.outcome ?? undefined);

	const handleSave = async () => {
		const body: { note?: string | null; outcome?: CampaignOutcome } = {};

		if (note !== (lead.note ?? "")) {
			body.note = note.trim().length > 0 ? note.trim() : null;
		}

		if (outcome !== undefined && outcome !== lead.outcome) {
			body.outcome = outcome;
		}

		if (Object.keys(body).length === 0) {
			return;
		}

		try {
			await updateLead.mutateAsync({ id: campaignId, leadId: lead.id, body });
		} catch {
			// Sabab hook'dagi toast'da.
		}
	};

	return (
		<div className="mt-6 border-t border-slate-100 pt-5">
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<div>
					<div className="mb-2 text-xs font-bold text-slate-700">Izoh</div>
					<Input.TextArea
						rows={3}
						value={note}
						maxLength={1000}
						onChange={(event) => setNote(event.target.value)}
						placeholder="Operator izohi"
						className="rounded-xl"
					/>
				</div>
				<div>
					<div className="mb-2 text-xs font-bold text-slate-700">Natijani qo'lda yozish</div>
					<Select<CampaignOutcome>
						allowClear
						value={outcome}
						options={OUTCOME_OPTIONS}
						onChange={(value) => setOutcome(value)}
						placeholder="Masalan: o'zim qo'ng'iroq qildim, rozi bo'ldi"
						className="h-11 w-full"
					/>
					<div className="mt-2 text-[11px] font-medium text-slate-400">
						Urinishlar soni oshmaydi. «Qo'ng'iroq qilinmasin» tanlansa raqam umumiy ro'yxatga
						qo'shiladi va boshqa hech qaysi kampaniyada terilmaydi.
					</div>
				</div>
			</div>

			{outcome === "do_not_call" && lead.outcome !== "do_not_call" && (
				<Alert
					type="warning"
					showIcon
					className="mt-4 rounded-xl"
					message="Bu raqam «qo'ng'iroq qilinmasin» ro'yxatiga qo'shiladi"
					description="Qaytarish faqat administrator orqali va faqat qo'lda kiritilgan yozuvlar uchun mumkin."
				/>
			)}

			<Button
				type="primary"
				icon={<SaveOutlined />}
				loading={updateLead.isPending}
				disabled={!isDirty}
				onClick={handleSave}
				className="mt-4 h-11 rounded-xl px-6 font-bold"
			>
				Saqlash
			</Button>
		</div>
	);
}

/**
 * One number's whole history.
 *
 * The attempt list exists because a lead can be rung several times and each ring
 * is its own `calls` row - the lead's own `callId` is only the latest. Every
 * attempt links to `/calls/:id`, which already holds the transcript, the
 * recording, the analysis and the cost; nothing of that is duplicated here.
 */
export function LeadDetailModal({ open, campaignId, lead, canManage, onClose }: Props) {
	const detailQuery = useCampaignLead(
		open && lead !== null ? campaignId : undefined,
		open && lead !== null ? lead.id : undefined
	);

	if (lead === null) {
		return null;
	}

	const current = detailQuery.data?.lead ?? lead;
	const attempts = detailQuery.data?.attempts ?? [];

	return (
		<Modal
			title={
				<div className="flex items-center gap-2 pb-2">
					<UserOutlined className="text-blue-600" />
					<span className="font-extrabold tracking-tight text-slate-900 uppercase">
						{current.phoneDisplay}
					</span>
				</div>
			}
			open={open}
			onCancel={onClose}
			footer={null}
			width={860}
			centered
			styles={{
				mask: { backdropFilter: "blur(4px)" },
				body: { maxHeight: "72vh", overflowY: "auto" },
			}}
		>
			<LeadSummary lead={current} />

			<div className="mt-5">
				<div className="mb-2 flex items-center gap-2 text-[10px] font-black tracking-widest text-slate-400 uppercase">
					<HistoryOutlined /> Urinishlar tarixi
				</div>
				{detailQuery.isLoading ? (
					<Skeleton active paragraph={{ rows: 3 }} />
				) : (
					<Table<LeadAttempt>
						columns={ATTEMPT_COLUMNS}
						dataSource={attempts}
						rowKey="id"
						size="small"
						pagination={false}
						scroll={{ x: 800 }}
						locale={{ emptyText: "Hali qo'ng'iroq qilinmagan" }}
					/>
				)}
			</div>

			{canManage && <LeadEditor campaignId={campaignId} lead={current} />}
		</Modal>
	);
}
