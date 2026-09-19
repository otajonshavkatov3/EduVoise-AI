import { Empty, Skeleton } from "antd";
import type { TranscriptLine } from "../../types/transcript";
import { TranscriptLineBubble } from "./TranscriptLineBubble";

interface Props {
	lines: TranscriptLine[];
	isLoading: boolean;
	searchQuery: string;
	canEdit: boolean;
	/** Pleerning joriy pozitsiyasi (ms) — mos qator ajratib ko'rsatiladi */
	playbackMs: number;
	savingLineId: string | null;
	onSeek: (ms: number) => void;
	onSaveLine: (id: string, content: string) => Promise<void>;
}

function isLineActive(line: TranscriptLine, playbackMs: number): boolean {
	if (line.startMs === null || playbackMs <= 0) {
		return false;
	}
	const end = line.endMs ?? line.startMs + 4000;
	return playbackMs >= line.startMs && playbackMs < end;
}

export function TranscriptTimeline({
	lines,
	isLoading,
	searchQuery,
	canEdit,
	playbackMs,
	savingLineId,
	onSeek,
	onSaveLine,
}: Props) {
	if (isLoading) {
		return (
			<div className="space-y-6 py-4">
				{[0, 1, 2, 3].map((row) => (
					<Skeleton key={row} active avatar paragraph={{ rows: 2 }} />
				))}
			</div>
		);
	}

	if (lines.length === 0) {
		return (
			<Empty
				className="py-16"
				image={Empty.PRESENTED_IMAGE_SIMPLE}
				description={
					searchQuery
						? "Qidiruv bo'yicha hech narsa topilmadi"
						: "Bu qo'ng'iroq uchun transkript hali yo'q"
				}
			/>
		);
	}

	return (
		<div className="space-y-5 py-2">
			{lines.map((line) => (
				<TranscriptLineBubble
					key={line.id}
					line={line}
					searchQuery={searchQuery}
					canEdit={canEdit}
					isActive={isLineActive(line, playbackMs)}
					isSaving={savingLineId === line.id}
					onSeek={onSeek}
					onSave={(content) => onSaveLine(line.id, content)}
				/>
			))}
		</div>
	);
}
