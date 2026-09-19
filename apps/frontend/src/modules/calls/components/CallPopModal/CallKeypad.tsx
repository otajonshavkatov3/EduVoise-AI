import { Button, Typography } from "antd";
import { useState } from "react";

const { Text } = Typography;

const DTMF_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

interface CallKeypadProps {
	onDigit: (digit: string) => void;
}

export function CallKeypad({ onDigit }: CallKeypadProps) {
	const [isOpen, setIsOpen] = useState(false);

	if (!isOpen) {
		return (
			<Button
				onClick={() => setIsOpen(true)}
				className="w-full h-10 rounded-xl border-dashed border-slate-200 text-slate-400 hover:text-blue-500 hover:border-blue-500 transition-all font-semibold"
			>
				Klaviatura (DTMF)
			</Button>
		);
	}

	return (
		<div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
			<div className="flex justify-between items-center mb-2">
				<Text className="text-[10px] font-black text-slate-400 uppercase tracking-wider">DTMF</Text>
				<Button
					type="text"
					size="small"
					onClick={() => setIsOpen(false)}
					className="text-slate-400"
				>
					✕
				</Button>
			</div>
			<div className="grid grid-cols-3 gap-2">
				{DTMF_KEYS.map((key) => (
					<button
						key={key}
						type="button"
						className="h-10 rounded-xl bg-white border border-slate-200 font-black text-slate-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all active:scale-95 shadow-sm text-sm"
						onClick={() => onDigit(key)}
					>
						{key}
					</button>
				))}
			</div>
		</div>
	);
}
