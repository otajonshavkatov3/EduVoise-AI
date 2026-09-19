import {
	ClockCircleOutlined,
	EditOutlined,
	EnvironmentOutlined,
	PhoneOutlined,
	RobotOutlined,
	SwapOutlined,
	UserOutlined,
} from "@ant-design/icons";
import {
	Button,
	Card,
	Dropdown,
	Empty,
	Popconfirm,
	Skeleton,
	Space,
	Tooltip,
	Typography,
} from "antd";
import type { Booking, BookingStatus } from "../types";
import { BOOKING_STATUS_CONFIG, BOOKING_STATUS_ORDER, BookingStatusTag } from "./BookingStatusTag";

const { Text } = Typography;

interface Props {
	bookings: Booking[];
	isLoading: boolean;
	/** Sarlavhada ko'rsatiladigan kun (YYYY-MM-DD) */
	dayLabel: string;
	onEdit: (booking: Booking) => void;
	onStatusChange: (booking: Booking, status: BookingStatus) => void;
	onCancel: (booking: Booking) => void;
}

function formatTimeRange(booking: Booking): string {
	const start = new Date(booking.scheduledAt);
	const end = new Date(booking.endsAt);
	const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
	return `${start.toLocaleTimeString([], options)} — ${end.toLocaleTimeString([], options)}`;
}

/** Tanlangan kun uchun kun tartibi (agenda) */
export function BookingAgenda({
	bookings,
	isLoading,
	dayLabel,
	onEdit,
	onStatusChange,
	onCancel,
}: Props) {
	if (isLoading) {
		return <Skeleton active paragraph={{ rows: 6 }} />;
	}

	if (bookings.length === 0) {
		return (
			<Empty
				className="py-10"
				image={Empty.PRESENTED_IMAGE_SIMPLE}
				description={`${dayLabel} uchun uchrashuv yo'q`}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			{bookings.map((booking) => (
				<Card
					key={booking.id}
					className="transition-all hover:shadow-md"
					styles={{ body: { padding: 16 } }}
				>
					<div className="mb-2 flex items-start justify-between gap-2">
						<div className="flex flex-col">
							<Space size={6}>
								<Text className="font-bold leading-tight text-slate-900">{booking.title}</Text>
								{booking.createdBySystem && (
									<Tooltip title="AI yaratgan uchrashuv">
										<RobotOutlined className="text-purple-500" />
									</Tooltip>
								)}
							</Space>
							<Space size={6} className="mt-1">
								<ClockCircleOutlined className="text-slate-300" />
								<Text className="font-mono text-[11px] font-bold text-slate-500">
									{formatTimeRange(booking)}
								</Text>
								<Text className="text-[11px] text-slate-400">({booking.durationMinutes} min)</Text>
							</Space>
						</div>
						<BookingStatusTag status={booking.status} />
					</div>

					<div className="mb-3 flex flex-wrap items-center gap-4">
						{booking.contact && (
							<Space size={4}>
								<PhoneOutlined className="text-slate-300" />
								<Text className="text-[11px] font-bold text-slate-500">
									{[booking.contact.firstName, booking.contact.lastName]
										.filter(Boolean)
										.join(" ") || "Noma'lum"}{" "}
									· {booking.contact.phoneNumber}
								</Text>
							</Space>
						)}
						{booking.assignee && (
							<Space size={4}>
								<UserOutlined className="text-slate-300" />
								<Text className="text-[11px] font-bold text-slate-500">
									{booking.assignee.extension}
								</Text>
							</Space>
						)}
						{booking.location && (
							<Space size={4}>
								<EnvironmentOutlined className="text-slate-300" />
								<Text className="text-[11px] font-bold text-slate-500">{booking.location}</Text>
							</Space>
						)}
					</div>

					{booking.notes && (
						<Text className="mb-3 block rounded-xl bg-slate-50 p-3 text-xs font-medium text-slate-500">
							{booking.notes}
						</Text>
					)}

					<Space size="small" wrap>
						<Button
							size="small"
							icon={<EditOutlined />}
							onClick={() => onEdit(booking)}
							className="rounded-xl font-bold"
						>
							Tahrirlash
						</Button>
						<Dropdown
							trigger={["click"]}
							menu={{
								items: BOOKING_STATUS_ORDER.filter((status) => status !== booking.status).map(
									(status) => ({
										key: status,
										label: BOOKING_STATUS_CONFIG[status].label,
										icon: BOOKING_STATUS_CONFIG[status].icon,
									})
								),
								onClick: ({ key }) => onStatusChange(booking, key as BookingStatus),
							}}
						>
							<Button size="small" icon={<SwapOutlined />} className="rounded-xl font-bold">
								Holat
							</Button>
						</Dropdown>
						{booking.status !== "cancelled" && (
							<Popconfirm
								title="Uchrashuvni bekor qilish?"
								description="Yozuv o'chirilmaydi, holati 'bekor qilingan' bo'ladi."
								okText="Ha"
								cancelText="Yo'q"
								onConfirm={() => onCancel(booking)}
							>
								<Button size="small" danger className="rounded-xl font-bold">
									Bekor qilish
								</Button>
							</Popconfirm>
						)}
					</Space>
				</Card>
			))}
		</div>
	);
}
