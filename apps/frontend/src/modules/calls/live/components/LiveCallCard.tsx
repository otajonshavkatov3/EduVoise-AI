import { HistoryOutlined, PhoneOutlined, UserOutlined } from "@ant-design/icons";
import { Card, Tag, Tooltip } from "antd";
import { formatPhone } from "@/shared/utils/phoneFormat";
import type { LiveCallRow, LiveCallStatus } from "../types";
import {
	elapsedSeconds,
	formatDuration,
	providerLabel,
	transferPhaseConfig,
} from "../utils/labels";
import { AiSessionStatusTag } from "./AiSessionStatusTag";
import { CallActionButtons } from "./CallActionButtons";
import { LiveCallStatusTag } from "./LiveCallStatusTag";

/**
 * Ikonka chipi holatga qarab rang oladi, shunda boshlanmoqda / jonli / tugagan
 * qo'ng'iroqlar bir qarashda ajralib turadi.
 */
const statusAccent: Record<LiveCallStatus, string> = {
	starting: "bg-blue-50 text-blue-600",
	live: "bg-emerald-50 text-emerald-600",
	transferring: "bg-amber-50 text-amber-600",
	transferred: "bg-blue-50 text-blue-600",
	ending: "bg-rose-50 text-rose-600",
	ended: "bg-slate-100 text-slate-400",
};

interface Props {
	row: LiveCallRow;
	nowMs: number;
	isSelected: boolean;
	onSelect: (callId: string) => void;
	onTransfer: (row: LiveCallRow) => void;
	onHangup: (row: LiveCallRow) => void;
	canHangup: boolean;
	isHangingUp: boolean;
}

export function LiveCallCard({
	row,
	nowMs,
	isSelected,
	onSelect,
	onTransfer,
	onHangup,
	canHangup,
	isHangingUp,
}: Props) {
	const isEnded = row.endedAtMs !== null;
	const seconds = isEnded ? row.durationSeconds : elapsedSeconds(row.startedAt, nowMs);
	const contactName = row.contact?.contactName ?? null;
	const transferConfig = transferPhaseConfig[row.transferStatus];
	const accentClass = isEnded ? statusAccent.ended : statusAccent[row.status];

	return (
		<Card
			className={`overflow-hidden transition-all ${
				isSelected
					? "border-blue-300 shadow-md ring-2 ring-blue-100"
					: "border-slate-100 shadow-sm hover:shadow-md"
			} ${isEnded ? "opacity-70" : ""}`}
			styles={{ body: { padding: 0 } }}
		>
			<button
				type="button"
				onClick={() => onSelect(row.callId)}
				className="block w-full cursor-pointer border-none bg-transparent p-5 text-left"
			>
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						<div
							className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg ${accentClass}`}
						>
							<PhoneOutlined />
						</div>
						<div className="min-w-0">
							<div className="truncate font-mono text-base font-bold text-slate-900">
								{formatPhone(row.callerNumber)}
							</div>
							<div className="mt-0.5 flex items-center gap-1.5 truncate text-xs">
								<UserOutlined className="text-slate-300" />
								{contactName ? (
									<span className="truncate font-semibold text-slate-600">{contactName}</span>
								) : (
									<span className="truncate font-semibold text-amber-600">Yangi mijoz</span>
								)}
							</div>
						</div>
					</div>

					<div className="flex shrink-0 flex-col items-end gap-1.5">
						<div
							className={`font-mono text-lg font-black tabular-nums ${
								isEnded ? "text-slate-400" : "text-slate-900"
							}`}
						>
							{formatDuration(seconds)}
						</div>
						<LiveCallStatusTag status={row.status} />
					</div>
				</div>

				<div className="mt-4 flex flex-wrap items-center gap-2">
					<AiSessionStatusTag
						status={row.aiSession?.status ?? null}
						errorMessage={row.aiSession?.errorMessage ?? null}
					/>
					<Tag className="m-0 rounded-lg border-none bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">
						{providerLabel(row.provider ?? row.aiSession?.provider ?? null)}
					</Tag>
					{row.transferStatus !== "none" && (
						<Tag
							color={transferConfig.color}
							className="m-0 rounded-lg border-none px-2 py-0.5 text-[11px] font-bold"
						>
							{transferConfig.label}
							{row.transferExtension ? ` · ${row.transferExtension}` : ""}
						</Tag>
					)}
					{row.isReturningCaller && (
						<Tooltip title={`Ilgari ${row.previousCallCount} marta qo'ng'iroq qilgan`}>
							<Tag
								icon={<HistoryOutlined />}
								className="m-0 rounded-lg border-none bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600"
							>
								Takroriy
							</Tag>
						</Tooltip>
					)}
				</div>

				{isEnded && (
					<div className="mt-3 text-[11px] font-semibold text-slate-400">
						Tugadi{row.endReason ? ` · ${row.endReason}` : ""}
					</div>
				)}
			</button>

			<div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3">
				<CallActionButtons
					row={row}
					canHangup={canHangup}
					isHangingUp={isHangingUp}
					onTransfer={onTransfer}
					onHangup={onHangup}
				/>
			</div>
		</Card>
	);
}
