import { DisconnectOutlined, ShareAltOutlined } from "@ant-design/icons";
import { Button, Popconfirm, Tooltip } from "antd";
import type { LiveCallRow } from "../types";

interface Props {
	row: LiveCallRow;
	/** Tugatish faqat admin/supervisor uchun (backend ham shu qoidani qo'llaydi). */
	canHangup: boolean;
	isHangingUp: boolean;
	transferLabel?: string;
	onTransfer: (row: LiveCallRow) => void;
	onHangup: (row: LiveCallRow) => void;
}

export function CallActionButtons({
	row,
	canHangup,
	isHangingUp,
	transferLabel = "Uzatish",
	onTransfer,
	onHangup,
}: Props) {
	const isEnded = row.endedAtMs !== null;

	return (
		<>
			<Button
				size="small"
				icon={<ShareAltOutlined />}
				disabled={isEnded}
				onClick={() => onTransfer(row)}
				className="rounded-xl font-bold"
			>
				{transferLabel}
			</Button>

			{canHangup ? (
				<Popconfirm
					title="Qo'ng'iroqni tugatish"
					description="Jonli qo'ng'iroq darhol uziladi. Davom etamizmi?"
					okText="Tugatish"
					cancelText="Bekor qilish"
					okButtonProps={{ danger: true }}
					disabled={isEnded}
					onConfirm={() => onHangup(row)}
				>
					<Button
						size="small"
						danger
						icon={<DisconnectOutlined />}
						disabled={isEnded}
						loading={isHangingUp}
						className="rounded-xl font-bold"
					>
						Tugatish
					</Button>
				</Popconfirm>
			) : (
				<Tooltip title="Qo'ng'iroqni tugatish faqat administrator va nazoratchi uchun">
					<Button
						size="small"
						danger
						icon={<DisconnectOutlined />}
						disabled
						className="rounded-xl font-bold"
					>
						Tugatish
					</Button>
				</Tooltip>
			)}
		</>
	);
}
