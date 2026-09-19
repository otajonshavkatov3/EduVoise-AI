import { Empty, Tag } from "antd";
import type { AiSessionTranscriptLine, TranscriptRole } from "../types";
import { formatClock, transcriptRoleConfig } from "../utils/labels";

interface Props {
	lines: AiSessionTranscriptLine[];
	truncated: boolean;
}

const roleStyles: Record<TranscriptRole, { bubble: string; avatar: string }> = {
	caller: {
		bubble: "bg-white border-slate-200 text-slate-700",
		avatar: "bg-blue-100 text-blue-600",
	},
	agent: {
		bubble: "bg-blue-50 border-blue-100 text-slate-800",
		avatar: "bg-blue-600 text-white",
	},
	system: {
		bubble: "bg-slate-50 border-dashed border-slate-200 text-slate-500",
		avatar: "bg-slate-200 text-slate-500",
	},
};

export function TranscriptTimeline({ lines, truncated }: Props) {
	if (lines.length === 0) {
		return (
			<div className="flex min-h-[240px] items-center justify-center">
				<Empty
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={
						<span className="text-sm font-medium text-slate-400">
							Bu sessiyada transkript saqlanmagan
						</span>
					}
				/>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			{truncated && (
				<div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-600">
					Transkript server tomonidan qisqartirilgan — faqat bir qismi ko'rsatilmoqda.
				</div>
			)}

			{lines.map((line) => {
				const role = transcriptRoleConfig[line.role];
				const styles = roleStyles[line.role];

				return (
					<div key={line.id} className="flex items-start gap-3">
						<div
							className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-[10px] font-black ${styles.avatar}`}
						>
							{role.short}
						</div>
						<div className="min-w-0 flex-1">
							<div className="mb-1 flex flex-wrap items-center gap-2">
								<span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
									{role.label}
								</span>
								<span className="font-mono text-[10px] text-slate-300">
									{formatClock(line.createdAt)}
								</span>
								{!line.isFinal && (
									<Tag className="m-0 rounded-md border-slate-200 bg-slate-50 text-[10px] font-bold text-slate-500">
										Oraliq
									</Tag>
								)}
								{line.confidence !== null && (
									<span className="text-[10px] font-bold text-slate-300">
										ishonch {line.confidence}%
									</span>
								)}
							</div>
							<div
								className={`whitespace-pre-wrap break-words rounded-2xl border px-4 py-2.5 text-sm leading-relaxed ${styles.bubble}`}
							>
								{line.content}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}
