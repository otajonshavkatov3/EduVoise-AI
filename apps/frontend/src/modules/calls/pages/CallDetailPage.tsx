import { Alert, Button, Empty, message, Skeleton, Space } from "antd";
import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { getApiErrorMessage, getApiErrorStatus } from "@/shared/utils/apiError";
import type { AudioPlayerHandle } from "../components/AudioPlayer";
import { CallActionsCard } from "../components/detail/CallActionsCard";
import { CallAnalysisCard } from "../components/detail/CallAnalysisCard";
import { CallCostCard } from "../components/detail/CallCostCard";
import { CallDetailHeader } from "../components/detail/CallDetailHeader";
import { CallRecordingCard } from "../components/detail/CallRecordingCard";
import { CallSessionCard } from "../components/detail/CallSessionCard";
import { CallSummaryCard } from "../components/detail/CallSummaryCard";
import { CallTranscriptCard } from "../components/detail/CallTranscriptCard";
import {
	useAnalysisProvenance,
	useRetryCallAnalysis,
	useUpdateCallAnalysis,
} from "../hooks/useCallAnalysis";
import { useCallFull } from "../hooks/useCallFull";
import { useUpdateTranscriptLine } from "../hooks/useTranscripts";
import { transcriptService } from "../services/transcript.service";
import type { UpdateAiAnalysisRequest } from "../types/analysis";
import type { TranscriptExportFormat, TranscriptFilters } from "../types/transcript";
import { hasCallerLine } from "../utils/callDetail";

/**
 * Transkriptni va AI xulosasini tuzatishga ruxsat berilgan rollar.
 * Transkript sahifasi va tahlil sahifasi ham aynan shu ro'yxatni ishlatgan.
 */
const EDITOR_ROLES = ["admin", "supervisor"];

const INITIAL_TRANSCRIPT_FILTERS: TranscriptFilters = {
	order: "asc",
	includeInterim: "false",
};

export default function CallDetailPage() {
	const { id = "" } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const user = useAuthStore((state) => state.user);
	const canEdit = Boolean(user && EDITOR_ROLES.includes(user.role));

	const [transcriptFilters, setTranscriptFilters] = useState<TranscriptFilters>(
		INITIAL_TRANSCRIPT_FILTERS
	);
	const [playbackMs, setPlaybackMs] = useState(0);
	const [savingLineId, setSavingLineId] = useState<string | null>(null);
	const [isExporting, setIsExporting] = useState(false);
	const [isEditingAnalysis, setIsEditingAnalysis] = useState(false);
	const playerRef = useRef<AudioPlayerHandle>(null);

	const includeInterim = transcriptFilters.includeInterim === "true";
	const query = useCallFull(id, includeInterim);
	const full = query.data?.data;

	const analysisId = full?.analysis?.id ?? null;
	const provenance = useAnalysisProvenance(analysisId);
	const updateAnalysis = useUpdateCallAnalysis(id);
	const retryAnalysis = useRetryCallAnalysis(id);
	const updateLine = useUpdateTranscriptLine(id);

	const hasRecording = Boolean(full?.recording);
	const hasTimedLines = (full?.transcripts.items ?? []).some((line) => line.startMs !== null);

	const retryPossible = useMemo(() => {
		// Serverning sharti — saqlangan tahlil matnida mijoz gapi bo'lishi. Aniq soni
		// kelmaguncha ko'rinib turgan transkriptdan xulosa qilinadi, shunda tugma
		// yuklanish paytida ham to'g'ri holatda turadi.
		if (provenance.data) {
			return provenance.data.callerTurnCount > 0;
		}
		return hasCallerLine(full?.transcripts.items ?? []);
	}, [provenance.data, full?.transcripts.items]);

	const handleSeek = (ms: number) => {
		if (!hasRecording) {
			message.info("Bu qo'ng'iroq uchun audio yozuv mavjud emas");
			return;
		}
		playerRef.current?.seekTo(ms);
	};

	const handleSaveLine = async (lineId: string, content: string) => {
		setSavingLineId(lineId);
		try {
			await updateLine.mutateAsync({ id: lineId, data: { content } });
		} catch {
			// Xato hook ichida ko'rsatiladi
		} finally {
			setSavingLineId(null);
		}
	};

	const handleExport = async (format: TranscriptExportFormat) => {
		setIsExporting(true);
		try {
			const blob = await transcriptService.export(id, {
				format,
				role: transcriptFilters.role,
				includeInterim: transcriptFilters.includeInterim,
			});
			const url = window.URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `transcript_${id}.${format}`;
			document.body.appendChild(anchor);
			anchor.click();
			window.URL.revokeObjectURL(url);
			document.body.removeChild(anchor);
		} catch (exportError) {
			message.error(getApiErrorMessage(exportError, "Transkriptni eksport qilib bo'lmadi"));
		} finally {
			setIsExporting(false);
		}
	};

	const handleSaveAnalysis = async (data: UpdateAiAnalysisRequest) => {
		if (!analysisId) {
			return;
		}
		try {
			await updateAnalysis.mutateAsync({ id: analysisId, data });
			setIsEditingAnalysis(false);
		} catch {
			// Xato hook ichida ko'rsatiladi
		}
	};

	const handleRetryAnalysis = () => {
		if (!analysisId) {
			return;
		}
		retryAnalysis.mutate(analysisId);
	};

	if (query.isLoading) {
		return (
			<div className="animate-fadeIn space-y-6">
				<Skeleton active paragraph={{ rows: 2 }} />
				<Skeleton active paragraph={{ rows: 6 }} />
			</div>
		);
	}

	// 404 — qo'ng'iroq yo'q yoki bu operatorniki emas (server ikkalasini ataylab
	// farqlamaydi). Bu ishlamay qolish emas, shuning uchun qizil xato emas.
	if (query.isError && getApiErrorStatus(query.error) === 404) {
		return (
			<div className="flex min-h-[60vh] items-center justify-center">
				<Empty description="Qo'ng'iroq topilmadi" image={Empty.PRESENTED_IMAGE_SIMPLE}>
					<Button type="primary" ghost onClick={() => navigate("/calls")}>
						Ro'yxatga qaytish
					</Button>
				</Empty>
			</div>
		);
	}

	// Xato va "topilmadi" ajratilgan: server yiqilganda "topilmadi" deb ko'rsatish
	// noto'g'ri ma'lumot berardi.
	if (query.isError) {
		return (
			<div className="animate-fadeIn mx-auto max-w-3xl">
				<Alert
					type="error"
					showIcon
					className="rounded-2xl"
					message="Qo'ng'iroq ma'lumotlarini yuklab bo'lmadi"
					description={getApiErrorMessage(query.error, "Server bilan aloqa yo'q")}
					action={
						<Space direction="vertical">
							<Button size="small" onClick={() => query.refetch()}>
								Qayta urinish
							</Button>
							<Button size="small" type="link" onClick={() => navigate("/calls")}>
								Ro'yxatga qaytish
							</Button>
						</Space>
					}
				/>
			</div>
		);
	}

	if (!full) {
		return (
			<div className="flex min-h-[60vh] items-center justify-center">
				<Empty description="Qo'ng'iroq topilmadi" image={Empty.PRESENTED_IMAGE_SIMPLE}>
					<Button type="primary" ghost onClick={() => navigate("/calls")}>
						Ro'yxatga qaytish
					</Button>
				</Empty>
			</div>
		);
	}

	return (
		<div className="animate-fadeIn">
			<CallDetailHeader
				call={full.call}
				recording={full.recording}
				isRefreshing={query.isFetching}
				onRefresh={() => {
					query.refetch();
				}}
			/>

			<CallSummaryCard call={full.call} hasAiSession={full.session !== null} />

			<div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
				<div className="space-y-6 xl:col-span-8">
					<CallRecordingCard
						recording={full.recording}
						recordings={full.recordings}
						callDuration={full.call.duration}
						hasTimedLines={hasTimedLines}
						playerRef={playerRef}
						onProgress={setPlaybackMs}
					/>

					<CallTranscriptCard
						callId={id}
						transcripts={full.transcripts}
						isLoading={query.isPlaceholderData}
						canEdit={canEdit}
						filters={transcriptFilters}
						onFiltersChange={(next) => setTranscriptFilters((current) => ({ ...current, ...next }))}
						playbackMs={playbackMs}
						savingLineId={savingLineId}
						isExporting={isExporting}
						onExport={handleExport}
						onSeek={handleSeek}
						onSaveLine={handleSaveLine}
					/>

					<CallAnalysisCard
						analysis={full.analysis}
						callAiStatus={full.call.aiStatus}
						correction={provenance.data?.lastCorrection ?? null}
						canEdit={canEdit}
						retryPossible={retryPossible}
						isEditing={isEditingAnalysis}
						isSaving={updateAnalysis.isPending}
						isRetrying={retryAnalysis.isPending}
						onStartEdit={() => setIsEditingAnalysis(true)}
						onCancelEdit={() => setIsEditingAnalysis(false)}
						onSave={handleSaveAnalysis}
						onRetry={handleRetryAnalysis}
					/>

					<CallActionsCard actions={full.actions} />
				</div>

				<div className="space-y-6 xl:col-span-4">
					<CallCostCard
						cost={full.cost}
						costVisible={full.costVisible}
						hasAiWork={Boolean(full.session || full.analysis)}
					/>

					<CallSessionCard session={full.session} />
				</div>
			</div>
		</div>
	);
}
