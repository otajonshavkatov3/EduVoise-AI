import { ArrowLeftOutlined, CloudDownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Space, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { formatPhone } from "@/shared/utils/phoneFormat";
import type { CallFullCall, CallFullRecording } from "../../types/callFull";
import { resolveRecordingUrl } from "../../utils/recordingUrl";
import { AiStatusTag } from "../AiStatusTag";
import { CallDirectionTag } from "../CallDirectionTag";
import { CallStatusBadge } from "../CallStatusBadge";

const { Text, Title } = Typography;

interface Props {
	call: CallFullCall;
	recording: CallFullRecording | null;
	isRefreshing: boolean;
	onRefresh: () => void;
}

export function CallDetailHeader({ call, recording, isRefreshing, onRefresh }: Props) {
	const navigate = useNavigate();
	const title = call.contactName?.trim() || formatPhone(call.callerNumber);

	return (
		<div className="mb-6 flex flex-wrap items-start justify-between gap-4">
			<div className="flex min-w-0 items-center gap-4">
				<Button
					icon={<ArrowLeftOutlined />}
					onClick={() => navigate("/calls")}
					aria-label="Qo'ng'iroqlar ro'yxatiga qaytish"
					className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-none bg-white text-slate-500 shadow-sm transition-all hover:text-blue-600!"
				/>
				<div className="min-w-0">
					<div className="mb-1 flex flex-wrap items-center gap-2">
						<Text className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
							Qo'ng'iroq kartasi
						</Text>
						<CallDirectionTag direction={call.direction} />
						<CallStatusBadge status={call.status} />
						<AiStatusTag status={call.aiStatus} />
					</div>
					<Title level={3} className="m-0! truncate font-black tracking-tight text-slate-900!">
						{title}
					</Title>
					<Text
						copyable={{ text: call.id, tooltips: ["ID nusxalash", "Nusxalandi"] }}
						className="font-mono text-[11px] text-slate-400"
					>
						{call.id}
					</Text>
				</div>
			</div>

			<Space size="small" wrap>
				<Button
					icon={<ReloadOutlined />}
					loading={isRefreshing}
					onClick={onRefresh}
					className="h-11 rounded-xl font-bold"
				>
					Yangilash
				</Button>
				{recording && (
					<Button
						href={resolveRecordingUrl(recording.url)}
						download={recording.fileName}
						target="_blank"
						rel="noreferrer"
						icon={<CloudDownloadOutlined />}
						className="h-11 rounded-xl border-none bg-blue-50 font-bold text-blue-600 transition-all hover:bg-blue-100!"
					>
						Yozuvni yuklash
					</Button>
				)}
			</Space>
		</div>
	);
}
