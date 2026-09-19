import { Tag } from "antd";
import type { TicketPriority } from "../types";

export const priorityConfig: Record<TicketPriority, { color: string; label: string }> = {
	low: { color: "cyan", label: "Past" },
	medium: { color: "gold", label: "O'rta" },
	high: { color: "red", label: "Yuqori" },
};

interface Props {
	priority: TicketPriority;
}

export function TicketPriorityTag({ priority }: Props) {
	const config = priorityConfig[priority];
	return (
		<Tag color={config.color} className="font-bold border-none rounded-full px-3 py-0 scale-90">
			{config.label}
		</Tag>
	);
}
