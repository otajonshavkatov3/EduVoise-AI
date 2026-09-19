import {
	CheckCircleOutlined,
	ClockCircleOutlined,
	MinusCircleOutlined,
	SyncOutlined,
} from "@ant-design/icons";
import { Tag } from "antd";
import type { ReactNode } from "react";
import type { FollowUpStatus } from "../types";

interface StatusConfig {
	color: string;
	icon: ReactNode;
	label: string;
	/** Kanban ustuni sarlavhasidagi ikonka rangi */
	columnClass: string;
}

export const FOLLOW_UP_STATUS_CONFIG: Record<FollowUpStatus, StatusConfig> = {
	open: {
		color: "blue",
		icon: <ClockCircleOutlined />,
		label: "Ochiq",
		columnClass: "text-blue-600",
	},
	in_progress: {
		color: "orange",
		icon: <SyncOutlined />,
		label: "Bajarilmoqda",
		columnClass: "text-amber-500",
	},
	done: {
		color: "green",
		icon: <CheckCircleOutlined />,
		label: "Bajarildi",
		columnClass: "text-emerald-500",
	},
	cancelled: {
		color: "default",
		icon: <MinusCircleOutlined />,
		label: "Bekor qilingan",
		columnClass: "text-slate-400",
	},
};

export const FOLLOW_UP_STATUS_ORDER: FollowUpStatus[] = [
	"open",
	"in_progress",
	"done",
	"cancelled",
];

interface Props {
	status: FollowUpStatus;
}

export function FollowUpStatusTag({ status }: Props) {
	const config = FOLLOW_UP_STATUS_CONFIG[status];
	return (
		<Tag
			color={config.color}
			icon={config.icon}
			className="rounded-lg border-none px-2 text-[10px] font-bold uppercase"
		>
			{config.label}
		</Tag>
	);
}
