import { ShareAltOutlined, SwapOutlined } from "@ant-design/icons";
import { Segmented, Typography } from "antd";
import type { TransferMode } from "../../hooks/useCallTransferModal";

const { Text } = Typography;

interface TransferModeSelectorProps {
	mode: TransferMode;
	onModeChange: (mode: TransferMode) => void;
}

export function TransferModeSelector({ mode, onModeChange }: TransferModeSelectorProps) {
	return (
		<div className="mb-4 mt-2">
			<Segmented
				value={mode}
				onChange={(v) => onModeChange(v as TransferMode)}
				options={[
					{
						label: (
							<div className="flex items-center gap-2 py-1">
								<ShareAltOutlined />
								<span className="font-bold">To'g'ridan-to'g'ri</span>
							</div>
						),
						value: "blind",
					},
					{
						label: (
							<div className="flex items-center gap-2 py-1">
								<SwapOutlined />
								<span className="font-bold">Konsultatsiya bilan</span>
							</div>
						),
						value: "attended",
					},
				]}
				block
				className="custom-segmented-tabs bg-slate-100 rounded-2xl p-1"
			/>
			<div className="mt-2 px-1">
				{mode === "blind" ? (
					<Text className="text-[10px] text-slate-400 font-medium">
						Qo'ng'iroq darhol ko'rsatilgan operatorga yo'naltiriladi va sizning liningiz uziladi.
					</Text>
				) : (
					<Text className="text-[10px] text-slate-400 font-medium">
						Asosiy qo'ng'iroq kutish rejimiga o'tadi, operatorga konsultatsiya qo'ng'irog'i
						qilinadi, tayyor bo'lgach ular birlashtiriladi.
					</Text>
				)}
			</div>
		</div>
	);
}
