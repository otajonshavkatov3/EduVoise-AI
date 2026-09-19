import { WarningOutlined } from "@ant-design/icons";
import { Alert, DatePicker, Form, Input, InputNumber, Modal, Select } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { useContacts } from "@/modules/contacts/hooks/useContacts";
import { useOperators } from "@/modules/operators/hooks/useOperators";
import { getApiErrorMessage, isConflictError } from "@/shared/utils/apiError";
import { useCreateBooking, useUpdateBooking } from "../hooks/useBookings";
import type { Booking, BookingStatus, CreateBookingRequest, UpdateBookingRequest } from "../types";
import { BOOKING_STATUS_CONFIG, BOOKING_STATUS_ORDER } from "./BookingStatusTag";

interface Props {
	open: boolean;
	/** Tahrirlash uchun mavjud uchrashuv; bo'lmasa yangi yaratiladi */
	booking?: Booking | null;
	/** Kalendarda tanlangan kun — yangi uchrashuv uchun taklif */
	defaultDate?: Dayjs | null;
	defaults?: {
		callId?: string;
		ticketId?: string;
		contactId?: string;
	};
	onClose: () => void;
}

interface FormValues {
	title: string;
	contactId: string;
	scheduledAt: Dayjs;
	durationMinutes: number;
	assignedTo?: string;
	location?: string;
	notes?: string;
	status?: BookingStatus;
}

export function BookingFormModal({ open, booking, defaultDate, defaults, onClose }: Props) {
	const [form] = Form.useForm<FormValues>();
	const [conflictMessage, setConflictMessage] = useState<string | null>(null);
	const createBooking = useCreateBooking();
	const updateBooking = useUpdateBooking();
	const { data: operatorsData, isLoading: isLoadingOperators } = useOperators({ limit: 100 });
	const { data: contactsData, isLoading: isLoadingContacts } = useContacts({ limit: 100 });

	const isEdit = Boolean(booking);

	useEffect(() => {
		if (!open) {
			return;
		}
		setConflictMessage(null);
		form.resetFields();
		if (booking) {
			form.setFieldsValue({
				title: booking.title,
				contactId: booking.contactId,
				scheduledAt: dayjs(booking.scheduledAt),
				durationMinutes: booking.durationMinutes,
				assignedTo: booking.assignedTo ?? undefined,
				location: booking.location ?? undefined,
				notes: booking.notes ?? undefined,
				status: booking.status,
			});
		} else {
			form.setFieldsValue({
				durationMinutes: 30,
				contactId: defaults?.contactId,
				scheduledAt: (defaultDate ?? dayjs()).hour(10).minute(0).second(0),
			});
		}
	}, [open, booking, defaultDate, defaults?.contactId, form]);

	const operatorOptions = (operatorsData?.data.items ?? []).map((operator) => ({
		value: operator.id,
		label: `${operator.extension} — ${operator.user?.phone ?? "Operator"}`,
	}));

	const contactOptions = (contactsData?.data.items ?? []).map((contact) => ({
		value: contact.id,
		label: `${[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Noma'lum"} — ${contact.phoneNumber}`,
	}));

	const toUpdatePayload = (values: FormValues): UpdateBookingRequest => ({
		title: values.title,
		notes: values.notes?.trim() ? values.notes.trim() : null,
		scheduledAt: values.scheduledAt.toISOString(),
		durationMinutes: values.durationMinutes,
		location: values.location?.trim() ? values.location.trim() : null,
		status: values.status,
		assignedTo: values.assignedTo ?? null,
	});

	const toCreatePayload = (values: FormValues): CreateBookingRequest => ({
		contactId: values.contactId,
		title: values.title,
		notes: values.notes?.trim() || undefined,
		scheduledAt: values.scheduledAt.toISOString(),
		durationMinutes: values.durationMinutes,
		location: values.location?.trim() || undefined,
		assignedTo: values.assignedTo || undefined,
		callId: defaults?.callId,
		ticketId: defaults?.ticketId,
	});

	const handleSubmit = async (values: FormValues) => {
		setConflictMessage(null);
		try {
			if (booking) {
				await updateBooking.mutateAsync({ id: booking.id, data: toUpdatePayload(values) });
			} else {
				await createBooking.mutateAsync(toCreatePayload(values));
			}
			onClose();
		} catch (error) {
			const fallback = isConflictError(error)
				? "Xodimning bu vaqtda boshqa uchrashuvi bor"
				: "Uchrashuvni saqlab bo'lmadi";
			setConflictMessage(getApiErrorMessage(error, fallback));
		}
	};

	return (
		<Modal
			open={open}
			title={isEdit ? "Uchrashuvni tahrirlash" : "Yangi uchrashuv"}
			onCancel={onClose}
			onOk={() => form.submit()}
			okText={isEdit ? "Saqlash" : "Yaratish"}
			cancelText="Bekor qilish"
			confirmLoading={createBooking.isPending || updateBooking.isPending}
			destroyOnHidden
			centered
			width={680}
		>
			{conflictMessage && (
				<Alert
					type="warning"
					showIcon
					icon={<WarningOutlined className="text-amber-400" />}
					className="mb-4 rounded-2xl"
					message="Vaqt to'qnashuvi"
					description={conflictMessage}
					closable
					onClose={() => setConflictMessage(null)}
				/>
			)}

			<Form form={form} layout="vertical" onFinish={handleSubmit} requiredMark={false}>
				<Form.Item
					name="title"
					label={
						<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
							Sarlavha
						</span>
					}
					rules={[{ required: true, message: "Sarlavha kiritilishi shart" }]}
				>
					<Input
						maxLength={255}
						placeholder="Masalan: Ofisda uchrashuv"
						className="h-12 rounded-xl border-slate-200 bg-slate-50"
					/>
				</Form.Item>

				<Form.Item
					name="contactId"
					label={
						<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
							Mijoz
						</span>
					}
					rules={[{ required: !isEdit, message: "Mijozni tanlang" }]}
				>
					<Select<string>
						showSearch
						disabled={isEdit}
						optionFilterProp="label"
						placeholder="Mijozni tanlang"
						loading={isLoadingContacts}
						options={contactOptions}
						className="custom-select h-12 w-full"
					/>
				</Form.Item>

				<div className="flex flex-col gap-4 md:flex-row">
					<Form.Item
						name="scheduledAt"
						label={
							<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
								Vaqt
							</span>
						}
						className="flex-1"
						rules={[{ required: true, message: "Vaqtni tanlang" }]}
					>
						<DatePicker
							showTime={{ format: "HH:mm" }}
							format="YYYY-MM-DD HH:mm"
							className="h-12 w-full rounded-xl border-slate-200 bg-slate-50"
						/>
					</Form.Item>

					<Form.Item
						name="durationMinutes"
						label={
							<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
								Davomiyligi (min)
							</span>
						}
						className="flex-1"
						rules={[{ required: true, message: "Davomiylikni kiriting" }]}
					>
						<InputNumber
							min={1}
							max={1440}
							step={15}
							className="h-12 w-full rounded-xl border-slate-200 bg-slate-50"
						/>
					</Form.Item>
				</div>

				<div className="flex flex-col gap-4 md:flex-row">
					<Form.Item
						name="assignedTo"
						label={
							<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
								Mas'ul xodim
							</span>
						}
						className="flex-1"
					>
						<Select<string>
							allowClear
							showSearch
							optionFilterProp="label"
							placeholder="Xodimni tanlang"
							loading={isLoadingOperators}
							options={operatorOptions}
							className="custom-select h-12 w-full"
						/>
					</Form.Item>

					{isEdit && (
						<Form.Item
							name="status"
							label={
								<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
									Holat
								</span>
							}
							className="flex-1"
						>
							<Select<BookingStatus>
								options={BOOKING_STATUS_ORDER.map((status) => ({
									value: status,
									label: BOOKING_STATUS_CONFIG[status].label,
								}))}
								className="custom-select h-12 w-full"
							/>
						</Form.Item>
					)}
				</div>

				<Form.Item
					name="location"
					label={
						<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
							Manzil
						</span>
					}
				>
					<Input
						maxLength={500}
						placeholder="Manzil yoki xona"
						className="h-12 rounded-xl border-slate-200 bg-slate-50"
					/>
				</Form.Item>

				<Form.Item
					name="notes"
					label={
						<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
							Izoh
						</span>
					}
				>
					<Input.TextArea rows={3} className="rounded-2xl border-slate-200 bg-slate-50" />
				</Form.Item>
			</Form>
		</Modal>
	);
}
