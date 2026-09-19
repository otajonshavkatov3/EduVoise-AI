import { EditOutlined } from "@ant-design/icons";
import { Button, Empty, Space, Tag, Typography } from "antd";
import { formatDateTime } from "@/shared/utils/datetime";
import type { AnalysisCorrection, UpdateAiAnalysisRequest } from "../../types/analysis";
import { AiAnalysisEditor, type AnalysisDraftSource } from "./AiAnalysisEditor";
import { SectionTitle } from "./SectionTitle";

const { Text } = Typography;

interface Props {
	current: AnalysisDraftSource;
	/** Xulosa qo'lda tuzatilgan bo'lsa — kim va qachon. */
	correction: AnalysisCorrection | null;
	canEdit: boolean;
	isEditing: boolean;
	isSaving: boolean;
	onStartEdit: () => void;
	onCancelEdit: () => void;
	onSave: (data: UpdateAiAnalysisRequest) => Promise<void>;
}

function CorrectionNote({ correction }: { correction: AnalysisCorrection | null }) {
	if (!correction) {
		return null;
	}

	const by = correction.byPhone ? ` · ${correction.byPhone}` : "";

	return (
		<Text type="secondary" className="mt-2 block text-[11px]">
			Qo'lda tuzatilgan: {formatDateTime(correction.at)}
			{by}
		</Text>
	);
}

/** AI xulosasi va kategoriyalari; ruxsat bo'lsa shu yerda tuzatiladi. */
export function AnalysisSummarySection({
	current,
	correction,
	canEdit,
	isEditing,
	isSaving,
	onStartEdit,
	onCancelEdit,
	onSave,
}: Props) {
	return (
		<div className="space-y-6">
			<div>
				<div className="mb-2 flex items-center justify-between">
					<SectionTitle>AI xulosasi</SectionTitle>
					{canEdit && !isEditing && (
						<Button
							size="small"
							icon={<EditOutlined />}
							onClick={onStartEdit}
							className="rounded-xl font-bold"
						>
							Tuzatish
						</Button>
					)}
				</div>

				{isEditing ? (
					<AiAnalysisEditor
						current={current}
						isSaving={isSaving}
						onSave={onSave}
						onCancel={onCancelEdit}
					/>
				) : (
					<>
						{current.summary ? (
							<div className="rounded-2xl border border-slate-100 bg-white p-4 text-sm font-medium leading-relaxed text-slate-800">
								{current.summary}
							</div>
						) : (
							<Empty
								className="rounded-2xl border border-dashed border-slate-200 py-8"
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={
									<span className="text-sm font-medium text-slate-400">
										Xulosa yo'q — AI hali xulosa yozmagan
									</span>
								}
							/>
						)}
						<CorrectionNote correction={correction} />
					</>
				)}
			</div>

			<div>
				<SectionTitle>Kategoriyalar</SectionTitle>
				<div className="mt-2">
					{current.categories && current.categories.length > 0 ? (
						<Space wrap size={[6, 6]}>
							{current.categories.map((category) => (
								<Tag
									key={category}
									className="rounded-lg border-slate-200 bg-slate-50 text-[11px] font-bold text-slate-600"
								>
									{category}
								</Tag>
							))}
						</Space>
					) : (
						<Text type="secondary" className="text-xs">
							Kategoriya belgilanmagan
						</Text>
					)}
				</div>
			</div>
		</div>
	);
}
