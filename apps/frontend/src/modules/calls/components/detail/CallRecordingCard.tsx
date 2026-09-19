import { AudioOutlined, InfoCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { Alert, Card, Space, Tag, Typography } from "antd";
import type { Ref } from "react";
import type { CallFullRecording } from "../../types/callFull";
import { formatBytes } from "../../utils/callDetail";
import { resolveRecordingUrl } from "../../utils/recordingUrl";
import { AudioPlayer, type AudioPlayerHandle } from "../AudioPlayer";

const { Text } = Typography;

interface Props {
	recording: CallFullRecording | null;
	/** Barcha fayllar — uzatilgan qo'ng'iroqda ikkitasi bo'lishi mumkin. */
	recordings: CallFullRecording[];
	/** Yozuv metadatasi bo'lmasa qo'ng'iroq davomiyligi ko'rsatiladi. */
	callDuration: number | null;
	/**
	 * Transkript qatorlarida vaqt tamg'asi bormi. Provayder uni har doim ham
	 * yozmaydi; tamg'a bo'lmasa "bosib tinglash" maslahati bajarib bo'lmaydigan
	 * ish taklif qilgan bo'lardi.
	 */
	hasTimedLines: boolean;
	playerRef: Ref<AudioPlayerHandle>;
	onProgress: (ms: number) => void;
}

function RecordingMeta({ recording }: { recording: CallFullRecording }) {
	const size = formatBytes(recording.sizeBytes);

	return (
		<Space wrap size={[6, 6]} className="mt-3">
			<Tag className="m-0 rounded-lg border-slate-200 bg-slate-50 font-mono text-[10px] text-slate-500">
				{recording.fileName}
			</Tag>
			<Tag className="m-0 rounded-lg border-slate-200 bg-slate-50 text-[10px] font-bold uppercase text-slate-500">
				{recording.format}
			</Tag>
			{size && (
				<Tag className="m-0 rounded-lg border-slate-200 bg-slate-50 text-[10px] font-bold text-slate-500">
					{size}
				</Tag>
			)}
		</Space>
	);
}

/**
 * Qo'ng'iroq yozuvi.
 *
 * Yozuvsiz qo'ng'iroq — odatiy hol (operator o'zi javob bergan yoki yozib olish
 * yoqilmagan), shuning uchun bo'sh holat xato emas, tushuntirish bilan chiqadi.
 */
export function CallRecordingCard({
	recording,
	recordings,
	callDuration,
	hasTimedLines,
	playerRef,
	onProgress,
}: Props) {
	const extras = recordings.filter((item) => item.fileName !== recording?.fileName);

	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<Space size="small">
					<AudioOutlined className="text-blue-500" />
					<span className="text-xs font-black uppercase tracking-widest">Qo'ng'iroq yozuvi</span>
				</Space>
			}
		>
			{recording && !recording.isAvailable && (
				<Alert
					type="warning"
					showIcon
					icon={<WarningOutlined />}
					className="mb-4 rounded-xl"
					message="Yozuv qaydi bor, fayl serverda topilmadi"
					description="Qator bazada saqlangan, lekin diskda fayl yo'q — o'chirilgan yoki ko'chirilgan."
				/>
			)}

			<AudioPlayer
				ref={playerRef}
				src={recording ? resolveRecordingUrl(recording.url) : null}
				fileName={recording?.fileName}
				fallbackDuration={recording?.durationSeconds ?? callDuration}
				onProgress={onProgress}
			/>

			{recording ? (
				<>
					<RecordingMeta recording={recording} />
					{hasTimedLines && (
						<div className="mt-3 flex items-center gap-2">
							<InfoCircleOutlined className="text-slate-400" />
							<Text className="text-[11px] font-medium text-slate-500">
								Transkriptdagi vaqt tamg'asini bosib, yozuvning o'sha joyidan tinglash mumkin
							</Text>
						</div>
					)}
				</>
			) : (
				<Text className="mt-3 block text-[11px] font-medium text-slate-500">
					Bu qo'ng'iroq yozib olinmagan.
				</Text>
			)}

			{extras.length > 0 && (
				<div className="mt-6 space-y-4 border-t border-slate-100 pt-5">
					<Text className="text-[10px] font-black uppercase tracking-widest text-slate-500">
						Qo'shimcha fayllar ({extras.length})
					</Text>
					{extras.map((item) => (
						<div key={item.fileName}>
							<AudioPlayer
								src={resolveRecordingUrl(item.url)}
								fileName={item.fileName}
								fallbackDuration={item.durationSeconds}
								compact
							/>
							<RecordingMeta recording={item} />
						</div>
					))}
				</div>
			)}
		</Card>
	);
}
