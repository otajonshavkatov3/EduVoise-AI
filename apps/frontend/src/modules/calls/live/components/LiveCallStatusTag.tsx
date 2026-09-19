import { Tag } from "antd";
import type { LiveCallStatus } from "../types";
import { liveCallStatusConfig } from "../utils/labels";

interface Props {
	status: LiveCallStatus;
}

export function LiveCallStatusTag({ status }: Props) {
	const config = liveCallStatusConfig[status] ?? {
		label: status,
		color: "default",
		dotClass: "bg-slate-400",
	};

	return (
		<Tag
			color={config.color}
			className="m-0 flex items-center gap-1.5 rounded-lg border-none px-2 py-0.5 text-[11px] font-bold"
		>
			<span className={`h-1.5 w-1.5 rounded-full ${config.dotClass}`} />
			{config.label}
		</Tag>
	);
}
