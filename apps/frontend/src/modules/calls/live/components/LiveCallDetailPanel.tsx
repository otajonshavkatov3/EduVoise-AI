import {
	EnvironmentOutlined,
	FileTextOutlined,
	ReloadOutlined,
	RobotOutlined,
	TagsOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Empty } from "antd";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { formatPhone } from "@/shared/utils/phoneFormat";
import { useLiveCallDetail } from "../hooks/useLiveCalls";
import { useLiveCallsStore } from "../store/liveCalls.store";
import type { LiveCallRow, TranscriptEntry } from "../types";
import {
	elapsedSeconds,
	formatAudioMs,
	formatDuration,
	providerLabel,
	transferPhaseConfig,
} from "../utils/labels";
import { AiSessionStatusTag } from "./AiSessionStatusTag";
import { CallActionButtons } from "./CallActionButtons";
import { LiveCallStatusTag } from "./LiveCallStatusTag";
import { TranscriptStream } from "./TranscriptStream";

interface Props {
	row: LiveCallRow | null;
	nowMs: number;
	canHangup: boolean;
	isHangingUp: boolean;
	onTransfer: (row: LiveCallRow) => void;
	onHangup: (row: LiveCallRow) => void;
}

/**
 * Zustand selektori har chaqiruvda bir xil havolani qaytarishi kerak, aks holda
 * cheksiz qayta render bo'ladi - shu sababli bo'sh ro'yxat modul darajasida.
 */
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];

interface MetaItemProps {
	label: string;
	value: string;
	mono?: boolean;
}

function MetaItem({ label, value, mono = false }: MetaItemProps) {
	return (
		<div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
			<div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
			<div
				className={`mt-0.5 truncate text-xs font-bold text-slate-700 ${mono ? "font-mono" : ""}`}
				title={value}
			>
				{value}
			</div>
		</div>
	);
}

/** AI sessiyasi va kanal ko'rsatkichlari. Sessiya ochilmagan bo'lsa "—" chiqadi. */
function SessionMetaGrid({ row }: { row: LiveCallRow }) {
	const session = row.aiSession;
	const transferConfig = transferPhaseConfig[row.transferStatus];

	return (
		<div className="grid grid-cols-2 gap-2 border-b border-slate-100 p-5 sm:grid-cols-3">
			<MetaItem
				label="Provayder"
				value={providerLabel(row.provider ?? session?.provider ?? null)}
			/>
			<MetaItem label="Model" value={session?.model ?? "—"} />
			<MetaItem label="Ovoz" value={session?.voice ?? "—"} />
			<MetaItem label="Til" value={session?.language ?? "—"} />
			<MetaItem label="To'xtatishlar" value={String(session?.interruptions ?? 0)} />
			<MetaItem label="Uzatish" value={transferConfig.label} />
			<MetaItem label="Kiruvchi audio" value={formatAudioMs(session?.inputAudioMs ?? null)} />
			<MetaItem label="Chiquvchi audio" value={formatAudioMs(session?.outputAudioMs ?? null)} />
			<MetaItem label="Kanal" value={row.channelId} mono />
		</div>
	);
}

export function LiveCallDetailPanel({
	row,
	nowMs,
	canHangup,
	isHangingUp,
	onTransfer,
	onHangup,
}: Props) {
	const navigate = useNavigate();
	const callId = row?.callId ?? null;
	const detail = useLiveCallDetail(callId);
	const seedTranscript = useLiveCallsStore((state) => state.seedTranscript);
	const transcript = useLiveCallsStore((state) =>
		callId ? (state.transcripts[callId] ?? EMPTY_TRANSCRIPT) : EMPTY_TRANSCRIPT
	);

	useEffect(() => {
		const data = detail.data?.data;
		if (!data) {
			return;
		}
		seedTranscript(data.callId, data.transcript);
	}, [detail.data, seedTranscript]);

	if (!row) {
		return (
			<Card
				className="h-full border-slate-100 shadow-sm"
				styles={{
					body: {
						minHeight: 420,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
					},
				}}
			>
				<Empty
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={
						<span className="text-sm font-medium text-slate-400">
							Transkriptni ko'rish uchun qo'ng'iroqni tanlang
						</span>
					}
				/>
			</Card>
		);
	}

	const isEnded = row.endedAtMs !== null;
	const seconds = isEnded ? row.durationSeconds : elapsedSeconds(row.startedAt, nowMs);
	const address = row.contact?.address ?? null;
	const session = row.aiSession;

	return (
		<Card
			className="flex h-full flex-col overflow-hidden border-slate-100 shadow-sm"
			styles={{
				body: { padding: 0, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
			}}
		>
			{/* Sarlavha */}
			<div className="border-b border-slate-100 p-5">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="truncate font-mono text-xl font-black text-slate-900">
							{formatPhone(row.callerNumber)}
						</div>
						<div className="mt-1 truncate text-sm font-semibold text-slate-500">
							{row.contact?.contactName ?? "Yangi mijoz — kontakt yaratilmagan"}
						</div>
						{address && (
							<div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
								<EnvironmentOutlined />
								<span className="truncate">
									{[address.tuman, address.kocha, address.uy].filter(Boolean).join(", ")}
								</span>
							</div>
						)}
					</div>

					<div className="flex flex-col items-end gap-2">
						<div className="font-mono text-2xl font-black tabular-nums text-slate-900">
							{formatDuration(seconds)}
						</div>
						<div className="flex flex-wrap items-center justify-end gap-2">
							<LiveCallStatusTag status={row.status} />
							<AiSessionStatusTag
								status={session?.status ?? null}
								errorMessage={session?.errorMessage ?? null}
							/>
						</div>
					</div>
				</div>

				<div className="mt-4 flex flex-wrap items-center gap-2">
					<CallActionButtons
						row={row}
						canHangup={canHangup}
						isHangingUp={isHangingUp}
						transferLabel="Operatorga uzatish"
						onTransfer={onTransfer}
						onHangup={onHangup}
					/>

					{row.ticketId && (
						<Button
							size="small"
							icon={<TagsOutlined />}
							onClick={() => navigate(`/tickets/${row.ticketId}`)}
							className="rounded-xl font-bold"
						>
							Murojaatni ochish
						</Button>
					)}

					<Button
						size="small"
						icon={<FileTextOutlined />}
						onClick={() => navigate(`/calls/${row.callId}`)}
						className="rounded-xl font-bold"
					>
						Qo'ng'iroq kartasi
					</Button>

					<Button
						size="small"
						icon={<ReloadOutlined />}
						loading={detail.isFetching}
						onClick={() => {
							detail.refetch();
						}}
						className="rounded-xl font-bold"
					>
						Yangilash
					</Button>
				</div>
			</div>

			{/* Meta */}
			<SessionMetaGrid row={row} />

			{session?.errorMessage && (
				<div className="px-5 pt-4">
					<Alert
						type="error"
						showIcon
						className="rounded-2xl"
						message="AI sessiyasi xatosi"
						description={session.errorMessage}
					/>
				</div>
			)}

			{row.aiSummary && (
				<div className="px-5 pt-4">
					<Alert
						type="info"
						showIcon
						icon={<RobotOutlined />}
						className="rounded-2xl"
						message="Qo'ng'iroqdan keyingi xulosa"
						description={row.aiSummary}
					/>
				</div>
			)}

			{detail.isError && (
				<div className="px-5 pt-4">
					<Alert
						type="warning"
						showIcon
						className="rounded-2xl"
						message="Saqlangan transkriptni olib bo'lmadi"
						description="Jonli oqim ishlayapti, lekin bazadagi qatorlar yuklanmadi."
					/>
				</div>
			)}

			{/* Transkript */}
			<div className="flex min-h-0 flex-1 flex-col p-5">
				<div className="mb-3 flex items-center justify-between">
					<div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
						Jonli transkript
					</div>
					<div className="text-[10px] font-bold text-slate-400">
						{transcript.length} qator
						{detail.data?.data.transcriptCount
							? ` · bazada ${detail.data.data.transcriptCount}`
							: ""}
					</div>
				</div>
				<TranscriptStream
					entries={transcript}
					isLoading={detail.isLoading}
					heightClass="h-[380px] lg:h-[440px]"
				/>
			</div>
		</Card>
	);
}
