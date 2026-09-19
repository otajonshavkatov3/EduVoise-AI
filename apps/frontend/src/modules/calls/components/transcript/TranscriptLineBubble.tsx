import { CheckOutlined, CloseOutlined, EditOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { Avatar, Button, Input, Tag, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { TranscriptLine } from "../../types/transcript";
import { formatConfidence, formatOffset, ROLE_STYLES, splitByQuery } from "../../utils/transcript";

const { Text } = Typography;

interface Props {
	line: TranscriptLine;
	/** Qidiruv so'zi — mos joylar belgilanadi */
	searchQuery: string;
	/** Tuzatish huquqi bor bo'lsa tahrirlash tugmasi ko'rsatiladi */
	canEdit: boolean;
	/** Ayni vaqtda o'ynatilayotgan qator */
	isActive: boolean;
	isSaving: boolean;
	/** Vaqt tamg'asi bosilganda (ms) */
	onSeek: (ms: number) => void;
	onSave: (content: string) => Promise<void>;
}

export function TranscriptLineBubble({
	line,
	searchQuery,
	canEdit,
	isActive,
	isSaving,
	onSeek,
	onSave,
}: Props) {
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState(line.content);
	const style = ROLE_STYLES[line.role];
	const confidence = formatConfidence(line.confidence);
	const segments = useMemo(
		() => splitByQuery(line.content, searchQuery),
		[line.content, searchQuery]
	);

	useEffect(() => {
		setDraft(line.content);
	}, [line.content]);

	const handleSave = async () => {
		const trimmed = draft.trim();
		if (trimmed.length === 0 || trimmed === line.content) {
			setIsEditing(false);
			setDraft(line.content);
			return;
		}
		await onSave(trimmed);
		setIsEditing(false);
	};

	const alignment =
		style.side === "right" ? "flex-row-reverse" : style.side === "center" ? "flex-col" : "flex-row";

	return (
		<div
			className={`flex w-full gap-3 ${style.side === "center" ? "items-center" : "items-start"} ${alignment}`}
		>
			<Avatar size={36} className={`shrink-0 font-black ${style.avatarClass}`}>
				{style.short}
			</Avatar>

			<div
				className={`max-w-full flex-1 ${style.side === "center" ? "text-center" : ""} ${
					style.side === "right" ? "items-end" : ""
				}`}
			>
				<div
					className={`mb-1 flex flex-wrap items-center gap-2 ${
						style.side === "right" ? "justify-end" : ""
					}`}
				>
					<Text className="text-[10px] font-black uppercase tracking-widest text-slate-500">
						{style.label}
					</Text>

					<Tooltip title="Yozuvda shu joydan tinglash">
						<Button
							type="text"
							size="small"
							disabled={line.startMs === null}
							icon={<PlayCircleOutlined />}
							onClick={() => onSeek(line.startMs ?? 0)}
							className="h-6 rounded-lg px-2 font-mono text-[10px] font-bold text-slate-500 transition-colors hover:bg-blue-50! hover:text-blue-600!"
						>
							{formatOffset(line.startMs)}
						</Button>
					</Tooltip>

					{!line.isFinal && (
						<Tag className="rounded-md border-none bg-amber-50 text-[9px] font-bold uppercase text-amber-600">
							Yakunlanmagan
						</Tag>
					)}

					{confidence && (
						<Tooltip title="Tanib olish ishonchi">
							<Tag className="rounded-md border-none bg-slate-100 text-[9px] font-bold text-slate-500">
								{confidence}
							</Tag>
						</Tooltip>
					)}

					{canEdit && !isEditing && (
						<Button
							type="text"
							size="small"
							icon={<EditOutlined />}
							onClick={() => setIsEditing(true)}
							className="h-6 rounded-lg px-2 text-[10px] font-bold text-slate-500 hover:text-blue-600!"
						>
							Tuzatish
						</Button>
					)}
				</div>

				{isEditing ? (
					<div className="space-y-2">
						<Input.TextArea
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							autoSize={{ minRows: 2, maxRows: 8 }}
							maxLength={10000}
							className="rounded-2xl border-slate-200 bg-slate-50 font-medium text-slate-900"
						/>
						<div className="flex justify-end gap-2">
							<Button
								size="small"
								icon={<CloseOutlined />}
								onClick={() => {
									setIsEditing(false);
									setDraft(line.content);
								}}
								className="rounded-xl font-bold"
							>
								Bekor
							</Button>
							<Button
								size="small"
								type="primary"
								icon={<CheckOutlined />}
								loading={isSaving}
								onClick={handleSave}
								className="rounded-xl font-bold"
							>
								Saqlash
							</Button>
						</div>
					</div>
				) : (
					<div
						className={`inline-block rounded-2xl border px-4 py-3 text-sm font-medium leading-relaxed shadow-sm transition-all ${style.bubbleClass} ${
							isActive ? "ring-2 ring-blue-400 ring-offset-2" : ""
						}`}
					>
						{segments.map((segment) =>
							segment.isMatch ? (
								<mark
									key={`${line.id}-m-${segment.start}`}
									className="rounded bg-amber-200 px-0.5 text-slate-900"
								>
									{segment.text}
								</mark>
							) : (
								<span key={`${line.id}-t-${segment.start}`}>{segment.text}</span>
							)
						)}
					</div>
				)}
			</div>
		</div>
	);
}
