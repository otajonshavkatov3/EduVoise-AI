import { CalendarOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import {
	Alert,
	Badge,
	Button,
	Calendar,
	Card,
	Col,
	Row,
	Select,
	Space,
	Tooltip,
	Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useMemo, useState } from "react";
import { useOperators } from "@/modules/operators/hooks/useOperators";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { BookingAgenda } from "../components/BookingAgenda";
import { BookingFormModal } from "../components/BookingFormModal";
import { BOOKING_STATUS_CONFIG, BOOKING_STATUS_ORDER } from "../components/BookingStatusTag";
import { useBookingCalendar, useCancelBooking, useUpdateBooking } from "../hooks/useBookings";
import type { Booking, BookingStatus } from "../types";

const { Text } = Typography;

const DAY_KEY_FORMAT = "YYYY-MM-DD";

export default function BookingsPage() {
	const [selectedDate, setSelectedDate] = useState<Dayjs>(dayjs());
	const [panelDate, setPanelDate] = useState<Dayjs>(dayjs());
	const [status, setStatus] = useState<BookingStatus | undefined>(undefined);
	const [assignedTo, setAssignedTo] = useState<string | undefined>(undefined);
	const [editingBooking, setEditingBooking] = useState<Booking | null>(null);
	const [isFormOpen, setIsFormOpen] = useState(false);

	const { data: operatorsData, isLoading: isLoadingOperators } = useOperators({ limit: 100 });
	const { data, isLoading, isFetching, isError, error, refetch } = useBookingCalendar({
		view: "month",
		date: panelDate.format(DAY_KEY_FORMAT),
		status,
		assignedTo,
	});
	const updateBooking = useUpdateBooking();
	const cancelBooking = useCancelBooking();

	/**
	 * Kalendar kunlari xaritasi.
	 * Backend kunlarni UTC bo'yicha guruhlaydi, shu sababli katakcha kaliti ham
	 * serverdan kelgan `date` (YYYY-MM-DD) qiymati bilan solishtiriladi.
	 */
	const dayMap = useMemo(() => {
		const map = new Map<string, Booking[]>();
		for (const day of data?.data.days ?? []) {
			map.set(day.date, day.items);
		}
		return map;
	}, [data?.data.days]);

	const selectedKey = selectedDate.format(DAY_KEY_FORMAT);
	const selectedBookings = useMemo(() => {
		const items = dayMap.get(selectedKey) ?? [];
		return [...items].sort(
			(left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime()
		);
	}, [dayMap, selectedKey]);

	const operatorOptions = (operatorsData?.data.items ?? []).map((operator) => ({
		value: operator.id,
		label: `${operator.extension} — ${operator.user?.phone ?? "Operator"}`,
	}));

	const handleStatusChange = (booking: Booking, next: BookingStatus) => {
		updateBooking.mutate({ id: booking.id, data: { status: next } });
	};

	const openCreate = () => {
		setEditingBooking(null);
		setIsFormOpen(true);
	};

	const openEdit = (booking: Booking) => {
		setEditingBooking(booking);
		setIsFormOpen(true);
	};

	return (
		<div className="animate-fadeIn">
			<div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-center">
				<div>
					<h1 className="text-3xl font-black tracking-tight text-slate-900">Uchrashuvlar</h1>
					<p className="font-medium text-slate-500">
						Kalendar va kun tartibi — mijozlar bilan belgilangan uchrashuvlar
					</p>
				</div>

				<Space size="middle" wrap>
					<Select<BookingStatus>
						allowClear
						placeholder="Holat"
						options={BOOKING_STATUS_ORDER.map((item) => ({
							value: item,
							label: BOOKING_STATUS_CONFIG[item].label,
						}))}
						value={status}
						onChange={setStatus}
						className="custom-select h-12 w-[180px]"
					/>
					<Select<string>
						allowClear
						showSearch
						optionFilterProp="label"
						placeholder="Mas'ul xodim"
						loading={isLoadingOperators}
						options={operatorOptions}
						value={assignedTo}
						onChange={setAssignedTo}
						className="custom-select h-12 w-[220px]"
					/>
					<Tooltip title="Yangilash">
						<Button
							icon={<ReloadOutlined />}
							loading={isFetching}
							onClick={() => refetch()}
							className="h-12 w-12 rounded-xl"
						/>
					</Tooltip>
					<Button
						type="primary"
						icon={<PlusOutlined />}
						size="large"
						onClick={openCreate}
						className="h-12 rounded-xl px-6 font-bold shadow-lg shadow-blue-500/20"
					>
						Yangi uchrashuv
					</Button>
				</Space>
			</div>

			{isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Uchrashuvlarni yuklab bo'lmadi"
					description={getApiErrorMessage(error, "Server bilan aloqa yo'q")}
					action={
						<Button size="small" onClick={() => refetch()}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			<Row gutter={[24, 24]}>
				<Col xs={24} xl={15}>
					<Card
						className="overflow-hidden rounded-2xl border-none shadow-sm"
						title={
							<Space size="small">
								<CalendarOutlined className="text-[#2154B2]" />
								<span className="text-xs font-bold uppercase tracking-widest">
									{panelDate.format("YYYY — MMMM")}
								</span>
								<Badge
									count={data?.data.total ?? 0}
									showZero
									className="[&_.ant-badge-count]:bg-[#2154B2]"
								/>
							</Space>
						}
					>
						<Calendar
							value={selectedDate}
							mode="month"
							onSelect={(date) => {
								setSelectedDate(date);
								if (!date.isSame(panelDate, "month")) {
									setPanelDate(date);
								}
							}}
							onPanelChange={(date) => setPanelDate(date)}
							cellRender={(current, info) => {
								if (info.type !== "date") {
									return info.originNode;
								}
								const items = dayMap.get(current.format(DAY_KEY_FORMAT)) ?? [];
								if (items.length === 0) {
									return null;
								}
								return (
									<ul className="m-0 list-none space-y-0.5 border-l-2 border-l-[#2154B2] p-0 pl-1.5">
										{items.slice(0, 2).map((item) => (
											<li key={item.id} className="truncate text-[10px] leading-tight">
												<Badge
													status={BOOKING_STATUS_CONFIG[item.status].badgeStatus}
													text={
														<span className="text-[10px] font-bold text-slate-600">
															{item.title}
														</span>
													}
												/>
											</li>
										))}
										{items.length > 2 && (
											<li className="text-[10px] font-black text-[#2154B2]">
												+{items.length - 2} ta
											</li>
										)}
									</ul>
								);
							}}
						/>
					</Card>
				</Col>

				<Col xs={24} xl={9}>
					<Card
						className="overflow-hidden rounded-2xl border-none shadow-sm"
						title={
							<div className="flex flex-col">
								<Text className="text-xs font-bold uppercase tracking-widest text-slate-900">
									Kun tartibi
								</Text>
								<Text className="text-[11px] font-medium text-slate-500">
									{selectedDate.format("DD MMMM YYYY")} · {selectedBookings.length} ta uchrashuv
								</Text>
							</div>
						}
					>
						<BookingAgenda
							bookings={selectedBookings}
							isLoading={isLoading}
							dayLabel={selectedDate.format("DD MMMM")}
							onEdit={openEdit}
							onStatusChange={handleStatusChange}
							onCancel={(booking) => cancelBooking.mutate(booking.id)}
						/>
					</Card>
				</Col>
			</Row>

			<BookingFormModal
				open={isFormOpen}
				booking={editingBooking}
				defaultDate={selectedDate}
				onClose={() => {
					setIsFormOpen(false);
					setEditingBooking(null);
				}}
			/>
		</div>
	);
}
