import { CommentOutlined } from "@ant-design/icons";
import { Alert, Card, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import type { CallFullTranscripts } from "../../types/callFull";
import type { TranscriptExportFormat, TranscriptFilters } from "../../types/transcript";
import { filterTranscript } from "../../utils/callDetail";
import { TranscriptAppendModal } from "../transcript/TranscriptAppendModal";
import { TranscriptTimeline } from "../transcript/TranscriptTimeline";
import { TranscriptToolbar } from "../transcript/TranscriptToolbar";

const { Text } = Typography;

interface Props {
	callId: string;
	transcripts: CallFullTranscripts;
	isLoading: boolean;
	canEdit: boolean;
	filters: TranscriptFilters;
	onFiltersChange: (next: Partial<TranscriptFilters>) => void;
	/** Pleerning joriy pozitsiyasi — mos qator ajratib ko'rsatiladi. */
	playbackMs: number;
	savingLineId: string | null;
	isExporting: boolean;
	onExport: (format: TranscriptExportFormat) => void;
	onSeek: (ms: number) => void;
	onSaveLine: (id: string, content: string) => Promise<void>;
}

/**
 * Transkript yo'qligining sababi — bo'sh ro'yxatning ostiga izoh sifatida.
 *
 * Operator o'zi javob bergan qo'ng'iroqda transkript umuman yozilmaydi; buni
 * aytmaslik bo'sh kartani nosozlikka o'xshatib qo'yardi.
 */
function EmptyNote() {
	return (
		<Text className="block px-1 pb-2 text-center text-[11px] font-medium text-slate-500">
			Transkript faqat AI javob bergan qo'ng'iroqlarda yoziladi. Kerak bo'lsa qatorni qo'lda
			qo'shish mumkin.
		</Text>
	);
}

/** Suhbat matni: qidiruv, rol, tartib, oraliq qatorlar, tuzatish va eksport. */
export function CallTranscriptCard({
	callId,
	transcripts,
	isLoading,
	canEdit,
	filters,
	onFiltersChange,
	playbackMs,
	savingLineId,
	isExporting,
	onExport,
	onSeek,
	onSaveLine,
}: Props) {
	const [isAppendOpen, setIsAppendOpen] = useState(false);

	const visible = useMemo(
		() => filterTranscript(transcripts.items, filters),
		[transcripts.items, filters]
	);

	const isFiltered = visible.length !== transcripts.items.length;

	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<Space size="small">
					<CommentOutlined className="text-emerald-500" />
					<span className="text-xs font-black uppercase tracking-widest">Suhbat matni</span>
				</Space>
			}
			extra={
				<Space size={[6, 6]} wrap>
					<Tag className="m-0 rounded-lg border-slate-200 bg-slate-50 text-[10px] font-bold text-slate-500">
						{transcripts.total} qator
					</Tag>
					{isFiltered && (
						<Tag className="m-0 rounded-lg border-blue-100 bg-blue-50 text-[10px] font-bold text-blue-600">
							ko'rinmoqda: {visible.length}
						</Tag>
					)}
					{transcripts.includesInterim && (
						<Tag className="m-0 rounded-lg border-amber-100 bg-amber-50 text-[10px] font-bold text-amber-600">
							oraliq qatorlar bilan
						</Tag>
					)}
				</Space>
			}
		>
			{transcripts.truncated && (
				<Alert
					type="warning"
					showIcon
					className="mb-4 rounded-xl"
					message="Transkript to'liq ko'rsatilmadi"
					description={`Server bir so'rovda eng ko'pi ${transcripts.items.length} qator qaytaradi, bu qo'ng'iroqda esa ${transcripts.total} qator bor. To'liq matnni eksport qilib oling.`}
				/>
			)}

			<TranscriptToolbar
				filters={filters}
				onFiltersChange={onFiltersChange}
				canEdit={canEdit}
				isExporting={isExporting}
				onExport={onExport}
				onAppend={() => setIsAppendOpen(true)}
			/>

			<TranscriptTimeline
				lines={visible}
				isLoading={isLoading}
				searchQuery={filters.search ?? ""}
				canEdit={canEdit}
				playbackMs={playbackMs}
				savingLineId={savingLineId}
				onSeek={onSeek}
				onSaveLine={onSaveLine}
			/>

			{transcripts.total === 0 && !isLoading && <EmptyNote />}

			<TranscriptAppendModal
				open={isAppendOpen}
				callId={callId}
				suggestedStartMs={playbackMs}
				onClose={() => setIsAppendOpen(false)}
			/>
		</Card>
	);
}
