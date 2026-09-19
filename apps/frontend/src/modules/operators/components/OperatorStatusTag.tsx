import {
	CheckCircleOutlined,
	ClockCircleOutlined,
	MinusCircleOutlined,
	StopOutlined,
} from "@ant-design/icons";
import { Tag } from "antd";
import { OPERATOR_STATUS_LABELS } from "@/shared/utils/labels";
import type { OperatorStatus } from "../types";

export const operatorStatusConfig: Record<
	OperatorStatus,
	{ color: string; icon: React.ReactNode; label: string }
> = {
	online: {
		color: "success",
		icon: <CheckCircleOutlined />,
		label: OPERATOR_STATUS_LABELS.online,
	},
	offline: {
		color: "default",
		icon: <MinusCircleOutlined />,
		label: OPERATOR_STATUS_LABELS.offline,
	},
	pause: { color: "warning", icon: <ClockCircleOutlined />, label: OPERATOR_STATUS_LABELS.pause },
	busy: { color: "error", icon: <StopOutlined />, label: OPERATOR_STATUS_LABELS.busy },
};

interface Props {
	status: OperatorStatus;
}

export function OperatorStatusTag({ status }: Props) {
	const config = operatorStatusConfig[status];
	return (
		<Tag
			icon={config.icon}
			color={config.color}
			className="flex items-center gap-1.5 w-fit font-bold rounded-full border-none shadow-sm px-3 py-0.5 transition-all"
		>
			{config.label}
		</Tag>
	);
}
