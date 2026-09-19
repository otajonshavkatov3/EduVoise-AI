import { DeleteOutlined, PhoneOutlined } from "@ant-design/icons";
import { Button, Input, Tooltip } from "antd";
import type { QuickDialEntry } from "@/modules/calls/hooks/useDialpadModal";

interface DialpadKeypadProps {
	phoneNumber: string;
	isRegistered: boolean;
	isInCall: boolean;
	onDigit: (digit: string) => void;
	onDelete: () => void;
	onCall: (num?: string) => void;
	quickDial?: readonly QuickDialEntry[];
}

/**
 * Renders what was dialled.
 *
 * Short numbers are shown verbatim because they are dialplan extensions
 * (900 = AI agent, 600/601/602 = test tones, 101-104 = operators). Only longer
 * input is treated as an Uzbek subscriber number and grouped as +998 XX XXX XX XX.
 * The previous version always prefixed "+998", which made an extension look like
 * a malformed mobile number.
 */
const formatDisplayNumber = (val: string) => {
	const digits = val.replace(/\D/g, "");

	if (digits.length === 0) {
		return "";
	}

	if (digits.length <= 4 && !digits.startsWith("998")) {
		return digits;
	}

	const local = (digits.startsWith("998") ? digits.slice(3) : digits).slice(0, 9);

	let formatted = "+998";
	if (local.length > 0) {
		formatted += ` ${local.slice(0, 2)}`;
	}
	if (local.length > 2) {
		formatted += ` ${local.slice(2, 5)}`;
	}
	if (local.length > 5) {
		formatted += ` ${local.slice(5, 7)}`;
	}
	if (local.length > 7) {
		formatted += ` ${local.slice(7, 9)}`;
	}

	return formatted;
};

const numbers = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function DialpadKeypad({
	phoneNumber,
	isRegistered,
	isInCall,
	onDigit,
	onDelete,
	onCall,
	quickDial,
}: DialpadKeypadProps) {
	const display = formatDisplayNumber(phoneNumber);
	const digitCount = phoneNumber.replace(/\D/g, "").length;

	return (
		<div className="flex flex-col items-center h-full px-8 py-6 animate-fadeIn">
			<div className="w-full mb-4">
				<Input
					value={display}
					placeholder="Raqam yoki ichki raqam"
					readOnly
					variant="borderless"
					className="text-4xl font-black text-center w-full text-slate-900 tracking-tight"
					style={{ padding: "20px 0" }}
				/>
				<div className="h-1 w-full flex justify-center">
					<div className="w-12 h-1 bg-blue-500 rounded-full" />
				</div>
			</div>

			{quickDial && quickDial.length > 0 && (
				<div className="w-full mb-4 flex flex-wrap justify-center gap-2">
					{quickDial.map((entry) => (
						<Tooltip key={entry.number} title={`${entry.number} — ${entry.label}`}>
							<Button
								type="text"
								size="small"
								disabled={!isRegistered || isInCall}
								onClick={() => onCall(entry.number)}
								className="rounded-full bg-slate-50 hover:bg-slate-100! border border-slate-200 text-slate-600 font-semibold px-3 h-8 disabled:opacity-40"
							>
								<span className="text-blue-600 font-bold">{entry.number}</span>
								<span className="ml-1.5 text-slate-500 font-medium">{entry.label}</span>
							</Button>
						</Tooltip>
					))}
				</div>
			)}

			<div className="grid grid-cols-3 gap-x-6 gap-y-4 w-full">
				{numbers.map((num) => (
					<Button
						key={num}
						type="text"
						onClick={() => onDigit(num)}
						className="h-20 w-25 mx-auto flex items-center justify-center rounded-2xl bg-slate-50 hover:bg-slate-100! text-2xl font-bold text-slate-700 transition-all border-none"
					>
						{num}
					</Button>
				))}
				<div />
				<Button
					type="text"
					onClick={onDelete}
					disabled={digitCount === 0}
					icon={<DeleteOutlined className="text-xl" />}
					className="h-20 w-25 mx-auto flex items-center justify-center rounded-2xl bg-slate-50 hover:bg-slate-100! text-slate-400 transition-all border-none disabled:opacity-40"
				/>
			</div>

			<Button
				type="primary"
				block
				size="large"
				icon={<PhoneOutlined className="text-xl" />}
				onClick={() => onCall()}
				disabled={!isRegistered || isInCall || digitCount < 3}
				className={`h-16 rounded-3xl border-none flex items-center justify-center gap-3 text-lg font-black shadow-xl mt-6 transition-all hover:scale-[1.02] disabled:opacity-50 disabled:shadow-none ${
					isRegistered
						? "bg-emerald-500 hover:bg-emerald-600! text-white shadow-emerald-500/20"
						: "bg-slate-300 hover:bg-slate-400! text-slate-500 shadow-slate-200"
				}`}
			>
				{isRegistered
					? isInCall
						? "QO'NG'IROQ DAVOM ETAYOTGAN..."
						: "QO'NG'IROQ"
					: "SIP ULANMAGAN"}
			</Button>
		</div>
	);
}
