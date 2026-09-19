import { Tag, Tooltip } from "antd";
import type { AiSessionStatus } from "../types";
import { aiSessionStatusConfig } from "../utils/labels";

interface Props {
	status: AiSessionStatus;
	errorMessage?: string | null;
}

export function SessionStatusTag({ status, errorMessage }: Props) {
	const config = aiSessionStatusConfig[status] ?? { label: status, color: "default" };

	const tag = (
		<Tag color={config.color} className="m-0 rounded-lg border-none text-[11px] font-bold">
			{config.label}
		</Tag>
	);

	if (errorMessage) {
		return <Tooltip title={errorMessage}>{tag}</Tooltip>;
	}

	return tag;
}
