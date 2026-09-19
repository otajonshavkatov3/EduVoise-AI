import { AudioOutlined } from "@ant-design/icons";
import { Empty, Spin } from "antd";
import { useEffect, useRef } from "react";
import type { TranscriptEntry, TranscriptRole } from "../types";
import { formatClock, transcriptRoleConfig } from "../utils/labels";

interface Props {
	entries: TranscriptEntry[];
	isLoading?: boolean;
	/** Balandlik klassi, masalan "h-[420px]". */
	heightClass?: string;
}

/**
 * Yorug' chat oqimi: mijoz chapda kulrang pufakda, AI operator o'ngda ko'k
 * pufakda, tizim qatorlari esa markazda punktir ramkada - uchalasi bir qarashda
 * ajralib turadi.
 */
const roleStyles: Record<TranscriptRole, { bubble: string; avatar: string }> = {
	caller: {
		bubble: "bg-slate-50 border-slate-200 text-slate-700",
		avatar: "bg-slate-100 text-slate-500",
	},
	agent: {
		bubble: "bg-blue-50 border-blue-100 text-slate-800",
		avatar: "bg-blue-600 text-white",
	},
	system: {
		bubble: "bg-white border-dashed border-slate-200 text-slate-500",
		avatar: "bg-slate-100 text-slate-400",
	},
};

export function TranscriptStream({ entries, isLoading = false, heightClass = "h-[420px]" }: Props) {
	const bottomRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);

	// Foydalanuvchi yuqoriga chiqib o'qiyotgan bo'lsa avtomatik pastga tushirmaymiz.
	useEffect(() => {
		const container = scrollRef.current;
		if (!container) {
			return;
		}

		const onScroll = () => {
			const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
			stickToBottomRef.current = distance < 80;
		};

		container.addEventListener("scroll", onScroll);
		return () => container.removeEventListener("scroll", onScroll);
	}, []);

	// Oxirgi qatorning kaliti + uzunligi: interim matn o'sganda ham o'zgaradi.
	const lastEntry = entries.at(-1);
	const lastSignature = lastEntry ? `${lastEntry.key}:${lastEntry.content.length}` : "";

	useEffect(() => {
		if (lastSignature.length === 0) {
			return;
		}
		if (stickToBottomRef.current) {
			bottomRef.current?.scrollIntoView({ block: "end" });
		}
	}, [lastSignature]);

	if (isLoading && entries.length === 0) {
		return (
			<div className={`${heightClass} flex items-center justify-center`}>
				<Spin />
			</div>
		);
	}

	if (entries.length === 0) {
		return (
			<div className={`${heightClass} flex items-center justify-center`}>
				<Empty
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={
						<span className="text-xs font-medium text-slate-400">Transkript hali kelmadi</span>
					}
				/>
			</div>
		);
	}

	return (
		<div
			ref={scrollRef}
			className={`${heightClass} space-y-3 overflow-y-auto overflow-x-hidden pr-1`}
		>
			{entries.map((entry) => {
				const role = transcriptRoleConfig[entry.role];
				const styles = roleStyles[entry.role];

				if (entry.role === "system") {
					return (
						<div key={entry.key} className="flex justify-center">
							<div
								className={`max-w-[85%] rounded-2xl border px-3 py-2 text-center ${styles.bubble}`}
							>
								<div className="mb-0.5 flex items-center justify-center gap-2">
									<span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
										{role.label}
									</span>
									<span className="font-mono text-[10px] text-slate-300">
										{formatClock(entry.at)}
									</span>
									{!entry.isFinal && (
										<span className="flex items-center gap-1 text-[10px] font-bold text-amber-500">
											<AudioOutlined />
											yozilmoqda
										</span>
									)}
								</div>
								<div
									className={`whitespace-pre-wrap break-words text-xs font-medium leading-relaxed ${entry.isFinal ? "" : "italic opacity-80"}`}
								>
									{entry.content}
								</div>
							</div>
						</div>
					);
				}

				const isAgent = entry.role === "agent";

				return (
					<div
						key={entry.key}
						className={`flex items-start gap-3 ${isAgent ? "flex-row-reverse" : ""}`}
					>
						<div
							className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-[10px] font-bold ${styles.avatar}`}
						>
							{role.short}
						</div>
						<div className="flex min-w-0 max-w-[82%] flex-col">
							<div className={`mb-1 flex items-center gap-2 ${isAgent ? "flex-row-reverse" : ""}`}>
								<span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
									{role.label}
								</span>
								<span className="font-mono text-[10px] text-slate-300">
									{formatClock(entry.at)}
								</span>
								{!entry.isFinal && (
									<span className="flex items-center gap-1 text-[10px] font-bold text-amber-500">
										<AudioOutlined />
										yozilmoqda
									</span>
								)}
							</div>
							<div
								className={`whitespace-pre-wrap break-words rounded-2xl border px-3 py-2 text-sm leading-relaxed ${styles.bubble} ${entry.isFinal ? "" : "italic opacity-80"}`}
							>
								{entry.content}
							</div>
						</div>
					</div>
				);
			})}
			<div ref={bottomRef} />
		</div>
	);
}
