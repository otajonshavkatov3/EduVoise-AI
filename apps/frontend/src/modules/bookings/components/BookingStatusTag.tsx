import {
	CalendarOutlined,
	CheckCircleOutlined,
	CloseCircleOutlined,
	FlagOutlined,
} from "@ant-design/icons";
import { Tag } from "antd";
import type { ReactNode } from "react";
import type { BookingStatus } from "../types";

interface StatusConfig {
	color: string;
	icon: ReactNode;
	label: string;
	/** Kalendar katakchasidagi nuqta rangi */
	badgeStatus: "default" | "processing" | "success" | "error" | "warning";
}

export const BOOKING_STATUS_CONFIG: Record<BookingStatus, StatusConfig> = {
	scheduled: {
		color: "blue",
		icon: <CalendarOutlined />,
		label: "Belgilangan",
		badgeStatus: "processing",
	},
	confirmed: {
		color: "green",
		icon: <CheckCircleOutlined />,
		label: "Tasdiqlangan",
		badgeStatus: "success",
	},
	completed: {
		color: "cyan",
		icon: <FlagOutlined />,
		label: "Yakunlangan",
		badgeStatus: "default",
	},
	cancelled: {
		color: "red",
		icon: <CloseCircleOutlined />,
		label: "Bekor qilingan",
		badgeStatus: "error",
	},
};

export const BOOKING_STATUS_ORDER: BookingStatus[] = [
	"scheduled",
	"confirmed",
	"completed",
	"cancelled",
];

interface Props {
	status: BookingStatus;
}

export function BookingStatusTag({ status }: Props) {
	const config = BOOKING_STATUS_CONFIG[status];
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
