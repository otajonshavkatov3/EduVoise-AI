import {
	ArrowLeftOutlined,
	CloseCircleOutlined,
	CodeOutlined,
	FileTextOutlined,
	PhoneOutlined,
	ReloadOutlined,
	TagsOutlined,
} from "@ant-design/icons";
import {
	Alert,
	Button,
	Card,
	Descriptions,
	type DescriptionsProps,
	Empty,
	Skeleton,
	Tag,
} from "antd";
import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatTokens, NO_DATA } from "@/modules/ai-costs/utils/format";
import { AiStatusTag } from "@/modules/calls/components/AiStatusTag";
import { callStatusConfig } from "@/modules/calls/components/CallStatusBadge";
import type { CallStatus } from "@/modules/calls/types";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { formatPhone } from "@/shared/utils/phoneFormat";
import { SessionCostCard } from "../components/SessionCostCard";
import { SessionStatusTag } from "../components/SessionStatusTag";
import { TranscriptTimeline } from "../components/TranscriptTimeline";
import { useAiSession } from "../hooks/useAiAssistant";
import type { AiSessionDetail } from "../types";
import {
	contactName,
	formatAudioMs,
	formatDateTime,
	formatDurationMs,
	languageLabel,
	providerLabel,
} from "../utils/labels";

function FactLabel({ children }: { children: ReactNode }) {
	return (
		<span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
			{children}
		</span>
	);
}

function FactValue({ value, mono = false }: { value: string; mono?: boolean }) {
	return (
		<span className={`break-words text-sm font-bold text-slate-800 ${mono ? "font-mono" : ""}`}>
			{value}
		</span>
	);
}

/** The shared call-status map, so the raw backend enum never reaches the tag. */
function callStatusLabel(status: CallStatus): string {
	return callStatusConfig[status]?.label ?? status;
}

/** Qayd etilmagan hisoblagich — "ma'lumot yo'q", 0 emas. */
function tokenValue(value: number | null): string {
	return value === null ? NO_DATA : formatTokens(value);
}

/** Sessiya ko'rsatkichlari — sahifa render funksiyasidan ajratilgan. */
function sessionFactItems(session: AiSessionDetail): DescriptionsProps["items"] {
	const rows: { key: string; label: string; value: string; mono?: boolean }[] = [
		{ key: "provider", label: "Provayder", value: providerLabel(session.provider) },
		{ key: "model", label: "Model", value: session.model ?? "—", mono: true },
		{ key: "voice", label: "Ovoz", value: session.voice ?? "—" },
		{
			key: "language",
			label: "Til",
			value: session.language ? languageLabel(session.language) : "—",
		},
		{ key: "duration", label: "Davomiyligi", value: formatDurationMs(session.durationMs) },
		{ key: "interruptions", label: "To'xtatishlar", value: String(session.interruptions) },
		{ key: "inputAudio", label: "Kiruvchi audio", value: formatAudioMs(session.inputAudioMs) },
		{ key: "outputAudio", label: "Chiquvchi audio", value: formatAudioMs(session.outputAudioMs) },
		// Qayd etilmagan token soni "0" emas: nol sarf bilan umuman o'lchanmagan
		// sessiyani aralashtirib yuborish xarajat hisobini buzadi.
		{ key: "promptTokens", label: "Kirish tokenlari", value: tokenValue(session.promptTokens) },
		{
			key: "completionTokens",
			label: "Chiqish tokenlari",
			value: tokenValue(session.completionTokens),
		},
		{
			key: "responseTurns",
			label: "Javoblar soni",
			value: tokenValue(session.responseTurns),
		},
		{ key: "startedAt", label: "Boshlandi", value: formatDateTime(session.startedAt) },
		{ key: "endedAt", label: "Tugadi", value: formatDateTime(session.endedAt) },
		{ key: "channelId", label: "Kanal", value: session.channelId ?? "—", mono: true },
	];

	return rows.map((row) => ({
		key: row.key,
		label: <FactLabel>{row.label}</FactLabel>,
		children: <FactValue value={row.value} mono={row.mono} />,
	}));
}

export default function AiSessionDetailPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const query = useAiSession(id);
	const session = query.data?.data;

	return (
		<div className="animate-fadeIn">
			{/* Page Header */}
			<div className="mb-6 flex items-center gap-4">
				<Button
					icon={<ArrowLeftOutlined />}
					onClick={() => navigate("/ai-assistant")}
					className="flex h-11 w-11 items-center justify-center rounded-xl font-bold"
				/>
				<div className="min-w-0">
					<div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
						AI sessiyasi
					</div>
					<div className="truncate font-mono text-lg font-black text-slate-900">{id ?? "—"}</div>
				</div>
			</div>

			{query.isLoading && (
				<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
					<Skeleton active paragraph={{ rows: 8 }} />
				</Card>
			)}

			{query.isError && (
				<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
					<Alert
						type="error"
						showIcon
						icon={<CloseCircleOutlined className="text-rose-500" />}
						className="rounded-xl border-rose-200 bg-rose-50"
						message={<span className="font-bold text-rose-600">Sessiyani yuklab bo'lmadi</span>}
						description={
							<span className="text-slate-600">
								{getApiErrorMessage(query.error, "Server javob bermadi.")}
							</span>
						}
						action={
							<Button
								size="small"
								className="rounded-lg font-bold"
								onClick={() => {
									query.refetch();
								}}
							>
								Qayta urinish
							</Button>
						}
					/>
				</Card>
			)}

			{!(query.isLoading || query.isError || session) && (
				<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
					<div className="flex min-h-[280px] items-center justify-center">
						<Empty
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description={
								<span className="text-sm font-medium text-slate-400">Sessiya topilmadi</span>
							}
						>
							<Button onClick={() => navigate("/ai-assistant")} className="rounded-xl font-bold">
								Ro'yxatga qaytish
							</Button>
						</Empty>
					</div>
				</Card>
			)}

			{session && (
				<div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
					{/* Chap ustun: transkript */}
					<div className="xl:col-span-7">
						<Card
							className="border-none shadow-sm rounded-2xl overflow-hidden"
							title={
								<div className="flex items-center gap-3">
									<div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
										<FileTextOutlined />
									</div>
									<div>
										<div className="text-sm font-black text-slate-900 leading-none mb-1">
											To'liq transkript
										</div>
										<div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 leading-none">
											{session.transcript.length} qator · bazada {session.transcriptCount}
										</div>
									</div>
								</div>
							}
							extra={
								<Button
									size="small"
									icon={<ReloadOutlined />}
									loading={query.isFetching}
									onClick={() => {
										query.refetch();
									}}
									className="rounded-xl font-bold"
								>
									Yangilash
								</Button>
							}
						>
							<TranscriptTimeline
								lines={session.transcript}
								truncated={session.transcriptTruncated}
							/>
						</Card>
					</div>

					{/* O'ng ustun: meta */}
					<div className="space-y-6 xl:col-span-5">
						<Card
							className="border-none shadow-sm rounded-2xl overflow-hidden"
							title={
								<div className="min-w-0 py-3">
									<div className="truncate font-mono text-lg font-black text-slate-900 leading-tight">
										{formatPhone(session.call.callerNumber)}
									</div>
									<div className="truncate text-sm font-semibold text-slate-500">
										{session.contact
											? (contactName(session.contact.firstName, session.contact.lastName) ??
												"Ismi yo'q")
											: "Yangi mijoz"}
									</div>
								</div>
							}
							extra={
								<SessionStatusTag status={session.status} errorMessage={session.errorMessage} />
							}
						>
							{session.errorMessage && (
								<Alert
									type="error"
									showIcon
									icon={<CloseCircleOutlined className="text-rose-500" />}
									className="mb-4 rounded-xl border-rose-200 bg-rose-50"
									message={<span className="font-bold text-rose-600">Sessiya xatosi</span>}
									description={<span className="text-slate-600">{session.errorMessage}</span>}
								/>
							)}

							{/* One pair per row: this card sits in a ~590px sidebar column, and
							    Descriptions resolves `column` against the WINDOW width, so a
							    responsive object falls back to its xxl default of 3 on a wide
							    screen and squeezes the value cells down to ~30px. */}
							<Descriptions bordered size="small" column={1} items={sessionFactItems(session)} />

							<div className="mt-5 flex flex-wrap gap-2">
								<Button
									icon={<PhoneOutlined />}
									onClick={() => navigate(`/calls/${session.callId}`)}
									className="rounded-xl font-bold"
								>
									Qo'ng'iroq kartasi
								</Button>
								{session.call.ticketId && (
									<Button
										icon={<TagsOutlined />}
										onClick={() => navigate(`/tickets/${session.call.ticketId}`)}
										className="rounded-xl font-bold"
									>
										Murojaat
									</Button>
								)}
							</div>

							<div className="mt-5 flex flex-wrap items-center gap-2">
								<Tag className="m-0 rounded-lg border-slate-200 bg-slate-50 text-[11px] font-bold text-slate-500">
									{session.call.direction === "inbound" ? "Kiruvchi" : "Chiquvchi"}
								</Tag>
								<Tag className="m-0 rounded-lg border-slate-200 bg-slate-50 text-[11px] font-bold text-slate-500">
									Qo'ng'iroq holati: {callStatusLabel(session.call.status)}
								</Tag>
								{session.call.aiStatus && <AiStatusTag status={session.call.aiStatus} />}
							</div>
						</Card>

						<SessionCostCard cost={session.cost} />

						{session.metadata && Object.keys(session.metadata).length > 0 && (
							<Card
								className="border-none shadow-sm rounded-2xl overflow-hidden"
								title={
									<div className="flex items-center gap-3">
										<div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500">
											<CodeOutlined />
										</div>
										<span className="text-sm font-black text-slate-900">
											Orkestrator metama'lumotlari
										</span>
									</div>
								}
							>
								<pre className="m-0 max-h-80 overflow-auto rounded-xl border border-slate-100 bg-slate-50 p-4 font-mono text-[11px] leading-relaxed text-slate-600">
									{JSON.stringify(session.metadata, null, 2)}
								</pre>
							</Card>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
