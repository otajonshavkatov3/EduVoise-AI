import {
	CheckCircleOutlined,
	ClockCircleOutlined,
	CloseCircleOutlined,
	LoadingOutlined,
	MinusCircleOutlined,
} from "@ant-design/icons";
import { Tag } from "antd";
import type { ReactNode } from "react";
import type { AIStatus } from "../types";

interface StatusConfig {
	color: string;
	icon: ReactNode;
	label: string;
}

const AI_STATUS_CONFIG: Record<AIStatus, StatusConfig> = {
	pending: { color: "default", icon: <ClockCircleOutlined />, label: "Navbatda" },
	processing: { color: "processing", icon: <LoadingOutlined />, label: "Tahlil qilinmoqda" },
	completed: { color: "success", icon: <CheckCircleOutlined />, label: "Tahlil tayyor" },
	failed: { color: "error", icon: <CloseCircleOutlined />, label: "Tahlil xatosi" },
};

interface Props {
	status: AIStatus | null;
}

/** AI tahlili holati uchun teg */
export function AiStatusTag({ status }: Props) {
	if (!status) {
		return (
			<Tag
				icon={<MinusCircleOutlined />}
				className="rounded-lg border-none bg-slate-100 text-[10px] font-bold uppercase text-slate-500"
			>
				Yo'q
			</Tag>
		);
	}

	const config = AI_STATUS_CONFIG[status];

	return (
		<Tag
			color={config.color}
			icon={config.icon}
			className="rounded-lg border-none text-[10px] font-bold uppercase"
		>
			{config.label}
		</Tag>
	);
}
