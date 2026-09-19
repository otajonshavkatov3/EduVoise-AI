import {
	CheckCircleOutlined,
	ClockCircleOutlined,
	CloseCircleOutlined,
	DollarOutlined,
	PhoneOutlined,
	SyncOutlined,
	TeamOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import { Alert, Card, Progress, Tag, Tooltip } from "antd";
import type { ReactNode } from "react";
// Same formatters as /ai-costs: the figure is priced by the same backend code,
// so it must also be rounded and labelled the same way on both pages.
import { formatDuration, formatUsd, formatUzs, NO_DATA } from "@/modules/ai-costs/utils/format";
import type { CampaignProgress } from "../types";
import { OUTCOME_COLORS, OUTCOME_LABELS, OUTCOME_ORDER } from "../utils/labels";
import { TrunkNotice } from "./TrunkNotice";

interface Props {
	progress: CampaignProgress;
}

function Tile({
	icon,
	tone,
	value,
	title,
	hint,
}: {
	icon: ReactNode;
	tone: string;
	value: string | number;
	title: string;
	hint?: string;
}) {
	return (
		<Card className="border-slate-100 shadow-sm" styles={{ body: { padding: 16 } }}>
			<div className="flex items-center justify-between gap-3">
				<div className={`flex h-10 w-10 items-center justify-center rounded-xl text-base ${tone}`}>
					{icon}
				</div>
				<div className="text-2xl font-extrabold text-slate-900 tabular-nums">{value}</div>
			</div>
			<div className="mt-3">
				<div className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">{title}</div>
				{hint !== undefined && (
					<div className="mt-1 text-[11px] font-medium text-slate-400">{hint}</div>
				)}
			</div>
		</Card>
	);
}

/**
 * The three questions a campaign has to answer at a glance: how far through the
 * queue it is, what the calls produced, and what it cost.
 *
 * Outcomes are rendered from a fixed order rather than from `Object.keys`, so
 * the rows do not reshuffle between two refreshes; a zero outcome is hidden
 * because ten rows of "0" bury the two that matter.
 */
export function CampaignProgressPanel({ progress }: Props) {
	const { leads, outcomes, spend, window: callWindow, attempts } = progress;
	const handled = Math.max(0, leads.total - leads.pending - leads.calling);
	const percent = leads.total === 0 ? 0 : Math.round((handled / leads.total) * 100);
	const visibleOutcomes = OUTCOME_ORDER.filter((outcome) => (outcomes[outcome] ?? 0) > 0);
	const uzs = formatUzs(spend.costUzs);

	return (
		<div className="mb-6">
			<TrunkNotice dialing={progress.dialing} />

			{leads.stalledCalling > 0 && (
				<Alert
					type="warning"
					showIcon
					icon={<WarningOutlined />}
					className="mb-4 rounded-2xl"
					message={`${leads.stalledCalling} ta yozuv «qo'ng'iroq ketmoqda» holatida qotib qolgan`}
					description="Dialer to'xtab qolgan bo'lishi mumkin. Ro'yxatdan o'sha yozuvlarni «navbatga qaytarish» bilan tiklash mumkin."
				/>
			)}

			<Card className="mb-4 rounded-2xl border-none shadow-sm">
				<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
					<div>
						<div className="text-sm font-black text-slate-900">Navbat</div>
						<div className="text-[11px] font-medium text-slate-500">
							{handled} / {leads.total} ta raqam ishlandi · {attempts.total} ta urinish, shundan{" "}
							{attempts.withCall} tasida qo'ng'iroq bo'lgan
						</div>
					</div>
					<div
						className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-bold ${
							callWindow.openNow ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"
						}`}
					>
						<ClockCircleOutlined />
						{callWindow.start}–{callWindow.end} ({callWindow.timeZone}) · {callWindow.message}
					</div>
				</div>
				<Progress percent={percent} status={leads.calling > 0 ? "active" : "normal"} />
			</Card>

			<div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
				<Tile
					icon={<TeamOutlined />}
					tone="bg-slate-50 text-slate-400"
					value={leads.pending}
					title="Navbatda"
					hint="Qo'ng'iroq kutmoqda"
				/>
				<Tile
					icon={<SyncOutlined />}
					tone="bg-blue-50 text-blue-600"
					value={leads.calling}
					title="Liniyada"
					hint="Hozir qo'ng'iroq ketmoqda"
				/>
				<Tile
					icon={<CheckCircleOutlined />}
					tone="bg-emerald-50 text-emerald-600"
					value={leads.done}
					title="Tugallandi"
				/>
				<Tile
					icon={<CloseCircleOutlined />}
					tone="bg-rose-50 text-rose-600"
					value={leads.failed}
					title="Xatolik"
					hint="Qo'ng'iroq ketmadi"
				/>
				<Tile
					icon={<PhoneOutlined />}
					tone="bg-slate-50 text-slate-400"
					value={leads.skipped}
					title="O'tkazib yuborilgan"
				/>
			</div>

			<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
				<Card
					className="rounded-2xl border-none shadow-sm"
					title={<span className="text-sm font-black text-slate-900">Natijalar</span>}
				>
					{visibleOutcomes.length === 0 ? (
						<span className="text-xs font-medium text-slate-400 italic">
							Hali birorta qo'ng'iroq yakunlanmagan
						</span>
					) : (
						<div className="flex flex-wrap gap-2">
							{visibleOutcomes.map((outcome) => (
								<Tag
									key={outcome}
									color={OUTCOME_COLORS[outcome]}
									className="m-0 rounded-lg border-none px-3 py-1 text-xs font-bold"
								>
									{OUTCOME_LABELS[outcome]}: {outcomes[outcome]}
								</Tag>
							))}
						</div>
					)}
				</Card>

				<Card
					className="rounded-2xl border-none shadow-sm"
					title={
						<div className="flex items-center gap-2">
							<DollarOutlined className="text-blue-600" />
							<span className="text-sm font-black text-slate-900">Xarajat</span>
						</div>
					}
				>
					{spend.visible ? (
						<div className="grid grid-cols-2 gap-4">
							<div>
								<div className="text-2xl font-extrabold text-slate-900 tabular-nums">
									{spend.costUsd === null ? NO_DATA : formatUsd(spend.costUsd)}
								</div>
								<div className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
									Jami
								</div>
								{uzs !== null && (
									<div className="mt-1 text-[11px] font-medium text-slate-400">{uzs}</div>
								)}
							</div>
							<div>
								<div className="text-2xl font-extrabold text-slate-900 tabular-nums">
									{spend.costPerAnsweredUsd === null
										? NO_DATA
										: formatUsd(spend.costPerAnsweredUsd)}
								</div>
								<div className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
									Bir suhbatga
								</div>
								<div className="mt-1 text-[11px] font-medium text-slate-400">
									{spend.sessions ?? 0} ta suhbat ·{" "}
									{spend.callSeconds === null ? NO_DATA : formatDuration(spend.callSeconds)}
								</div>
							</div>
							{spend.unpricedSessions !== null && spend.unpricedSessions > 0 && (
								<div className="col-span-2">
									<Tooltip title="Bu sessiyalarda model yoki token hisobi yozilmagan, shuning uchun ular narxga qo'shilmadi (0 emas, «hisoblanmagan»)">
										<span className="rounded-md bg-amber-50 px-2 py-1 text-[10px] font-bold tracking-wider text-amber-600 uppercase">
											{spend.unpricedSessions} ta sessiya narxlanmadi
										</span>
									</Tooltip>
								</div>
							)}
						</div>
					) : (
						<span className="text-xs font-medium text-slate-400 italic">
							Xarajatni faqat nazoratchi va administrator ko'radi — /ai-costs bilan bir xil qoida.
						</span>
					)}
				</Card>
			</div>
		</div>
	);
}
