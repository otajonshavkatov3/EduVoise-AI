import { Tag } from "antd";
import { ROLE_LABELS } from "@/shared/utils/labels";
import type { UserRole } from "../types";

const roleColors: Record<UserRole, string> = {
	admin: "volcano",
	supervisor: "blue",
	manager: "green",
};

interface Props {
	role: UserRole;
}

export function UserRoleTag({ role }: Props) {
	return (
		<Tag
			color={roleColors[role]}
			className="font-bold px-3 py-0.5 rounded-full border-none shadow-sm"
		>
			{ROLE_LABELS[role]}
		</Tag>
	);
}
