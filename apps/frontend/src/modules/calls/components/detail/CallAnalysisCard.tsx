import { RobotOutlined } from "@ant-design/icons";
import { Card, Empty, Space, Typography } from "antd";
import type { ReactNode } from "react";
import { formatDateTime } from "@/shared/utils/datetime";
import type { AIStatus } from "../../types";
import type { AnalysisCorrection, UpdateAiAnalysisRequest } from "../../types/analysis";
import type { CallFullAnalysis } from "../../types/callFull";
import { formatAnalysisConfidence } from "../../utils/analysis";
import { AiStatusTag } from "../AiStatusTag";
import { AiSentimentTag } from "../analysis/AiSentimentTag";
import { AnalysisFailureAlert } from "../analysis/AnalysisFailureAlert";
import { AnalysisSummarySection } from "../analysis/AnalysisSummarySection";
import { SectionTitle } from "../analysis/SectionTitle";

const { Text } = Typography;

interface Props {
	analysis: CallFullAnalysis | null;
	/** Tahlil qatori bo'lmasa ham qo'ng'iroqda holat turishi mumkin. */
	callAiStatus: AIStatus | null;
	correction: AnalysisCorrection | null;
	canEdit: boolean;
	/** Mijoz gapi bormi — qayta tahlil shu shartga bog'liq. */
	retryPossible: boolean;
	isEditing: boolean;
	isSaving: boolean;
	isRetrying: boolean;
	onStartEdit: () => void;
	onCancelEdit: () => void;
	onSave: (data: UpdateAiAnalysisRequest) => Promise<void>;
	onRetry: () => void;
}

function CardShell({ extra, children }: { extra?: ReactNode; children: ReactNode }) {
	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<Space size="small">
					<RobotOutlined className="text-purple-500" />
					<span className="text-xs font-black uppercase tracking-widest">
						Sun'iy intellekt tahlili
					</span>
				</Space>
			}
			extra={extra}
		>
			{children}
		</Card>
	);
}

/**
 * Tahlil yo'q — bu buzilish emas.
 *
 * Operator o'zi javob bergan qo'ng'iroqda AI umuman ishtirok etmaydi, demak
 * tahlil qiladigan matn ham bo'lmaydi. Holat ma'lum bo'lsa (navbatda,
 * bajarilmoqda) shu aytiladi, aks holda sabab tushuntiriladi.
 */
function MissingAnalysis({ callAiStatus }: { callAiStatus: AIStatus | null }) {
	return (
		<Empty
			className="rounded-2xl border border-dashed border-slate-200 py-8"
			image={Empty.PRESENTED_IMAGE_SIMPLE}
			description={
				<div className="space-y-1">
					<div className="text-sm font-bold text-slate-500">
						{callAiStatus === "pending" || callAiStatus === "processing"
							? "Tahlil hali tayyor emas"
							: "Bu qo'ng'iroq uchun AI tahlili yaratilmagan"}
					</div>
					<div className="text-xs font-medium text-slate-400">
						Tahlil AI suhbatidan keyin avtomatik yoziladi. Operator o'zi javob bergan qo'ng'iroqda u
						bo'lmaydi.
					</div>
				</div>
			}
		/>
	);
}

export function CallAnalysisCard({
	analysis,
	callAiStatus,
	correction,
	canEdit,
	retryPossible,
	isEditing,
	isSaving,
	isRetrying,
	onStartEdit,
	onCancelEdit,
	onSave,
	onRetry,
}: Props) {
	if (!analysis) {
		return (
			<CardShell extra={<AiStatusTag status={callAiStatus} />}>
				<MissingAnalysis callAiStatus={callAiStatus} />
			</CardShell>
		);
	}

	const confidence = formatAnalysisConfidence(analysis.confidence);

	return (
		<CardShell
			extra={
				<Space size={[6, 6]} wrap>
					<AiStatusTag status={analysis.status} />
					<AiSentimentTag sentiment={analysis.sentiment} />
				</Space>
			}
		>
			<div className="space-y-6">
				{analysis.status === "failed" && (
					<AnalysisFailureAlert
						errorMessage={analysis.errorMessage}
						canRetry={canEdit}
						retryPossible={retryPossible}
						isRetrying={isRetrying}
						onRetry={onRetry}
					/>
				)}

				<AnalysisSummarySection
					current={{
						summary: analysis.summary,
						sentiment: analysis.sentiment,
						categories: analysis.categories,
					}}
					correction={correction}
					canEdit={canEdit}
					isEditing={isEditing}
					isSaving={isSaving}
					onStartEdit={onStartEdit}
					onCancelEdit={onCancelEdit}
					onSave={onSave}
				/>

				<div>
					<SectionTitle>Tahlil haqida</SectionTitle>
					<div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
						<div>
							<div className="text-[9px] font-black uppercase tracking-widest text-slate-400">
								Ishonch darajasi
							</div>
							<div className="mt-1 text-sm font-bold text-slate-800">
								{confidence ?? (
									<span className="text-xs font-medium italic text-slate-400">ma'lumot yo'q</span>
								)}
							</div>
						</div>
						<div>
							<div className="text-[9px] font-black uppercase tracking-widest text-slate-400">
								Tahlil qilingan
							</div>
							<div className="mt-1 text-sm font-bold text-slate-800">
								{formatDateTime(analysis.processedAt)}
							</div>
						</div>
						<div>
							<div className="text-[9px] font-black uppercase tracking-widest text-slate-400">
								Qayta urinishlar
							</div>
							<div className="mt-1 text-sm font-bold text-slate-800">{analysis.retryCount}</div>
						</div>
						<div>
							<div className="text-[9px] font-black uppercase tracking-widest text-slate-400">
								Tahlil matni
							</div>
							<div className="mt-1 text-sm font-bold text-slate-800">
								{analysis.hasTranscript ? (
									`${analysis.transcriptChars} belgi`
								) : (
									<span className="text-xs font-medium italic text-slate-400">saqlanmagan</span>
								)}
							</div>
						</div>
					</div>
					<Text className="mt-3 block text-[10px] font-medium text-slate-400">
						Tahlil ID: {analysis.id}
					</Text>
				</div>
			</div>
		</CardShell>
	);
}
