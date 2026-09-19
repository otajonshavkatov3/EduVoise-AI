import { ArrowLeftOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { Tag } from "antd";
import type { CallDirection } from "../types";

interface Props {
	direction: CallDirection;
}

export function CallDirectionTag({ direction }: Props) {
	const isInbound = direction === "inbound";
	return (
		<Tag
			icon={isInbound ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}
			color={isInbound ? "geekblue" : "purple"}
			className="rounded-lg border-none px-2 font-bold shadow-sm"
		>
			{isInbound ? "Kiruvchi" : "Chiquvchi"}
		</Tag>
	);
}
