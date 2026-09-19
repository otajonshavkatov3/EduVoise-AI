import { Tag, Tooltip } from "antd";
import type { AiSessionStatus } from "../types";
import { aiSessionStatusConfig } from "../utils/labels";

interface Props {
	status: AiSessionStatus | null;
	errorMessage?: string | null;
}

export function AiSessionStatusTag({ status, errorMessage }: Props) {
	if (status === null) {
		return (
			<Tooltip title="Bu qo'ng'iroq uchun AI sessiyasi ochilmagan">
				<Tag className="m-0 rounded-lg border-none px-2 py-0.5 text-[11px] font-bold">
					AI sessiyasi yo'q
				</Tag>
			</Tooltip>
		);
	}

	const config = aiSessionStatusConfig[status] ?? {
		label: status,
		color: "default",
		dotClass: "bg-slate-400",
	};

	const tag = (
		<Tag
			color={config.color}
			className="m-0 flex items-center gap-1.5 rounded-lg border-none px-2 py-0.5 text-[11px] font-bold"
		>
			<span className={`h-1.5 w-1.5 rounded-full ${config.dotClass}`} />
			{config.label}
		</Tag>
	);

	if (errorMessage) {
		return <Tooltip title={errorMessage}>{tag}</Tooltip>;
	}

	return tag;
}
