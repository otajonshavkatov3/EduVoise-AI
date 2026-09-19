import { Badge } from "antd";
import type { CallStatus } from "../types";

export const callStatusConfig: Record<CallStatus, { color: string; label: string }> = {
	ringing: { color: "blue", label: "Chalinmoqda" },
	answered: { color: "green", label: "Javob berilgan" },
	missed: { color: "red", label: "O'tkazib yuborilgan" },
	abandoned: { color: "orange", label: "Tashlab ketilgan" },
	completed: { color: "cyan", label: "Yakunlangan" },
};

interface Props {
	status: CallStatus;
}

export function CallStatusBadge({ status }: Props) {
	// Xom holat kalitini ko'rsatmaydi: backendga yangi holat qo'shilsa ham
	// foydalanuvchi inglizcha enum qiymatini emas, tushunarli matnni ko'radi.
	const config = callStatusConfig[status] || { color: "default", label: "Noma'lum holat" };
	return (
		<Badge
			status={config.color as "success" | "processing" | "default" | "error" | "warning"}
			text={
				<span
					className="font-bold text-xs uppercase"
					style={{ color: `var(--ant-${config.color}-color)` }}
				>
					{config.label}
				</span>
			}
		/>
	);
}
