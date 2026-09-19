import { Tag } from "antd";

interface Props {
	isActive: boolean;
}

export function UserStatusTag({ isActive }: Props) {
	return (
		<Tag
			color={isActive ? "success" : "default"}
			className="flex items-center gap-1.5 w-fit font-bold rounded-full border-none shadow-sm px-3 py-0.5"
		>
			<div className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-green-500" : "bg-gray-400"}`} />
			{isActive ? "Faol" : "Nofaol"}
		</Tag>
	);
}
