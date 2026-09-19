import { Badge } from "antd";
import type { TicketStatus } from "../types";

export const statusConfig: Record<TicketStatus, { color: string; label: string }> = {
	new: { color: "blue", label: "Yangi" },
	in_progress: { color: "orange", label: "Jarayonda" },
	resolved: { color: "green", label: "Hal qilingan" },
	closed: { color: "default", label: "Yopilgan" },
	reopened: { color: "magenta", label: "Qayta ochilgan" },
};

interface Props {
	status: TicketStatus;
}

export function TicketStatusBadge({ status }: Props) {
	const config = statusConfig[status];
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
