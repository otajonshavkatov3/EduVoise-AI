import { DatePicker, Form, Input, Modal, Select } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect } from "react";
import { useContacts } from "@/modules/contacts/hooks/useContacts";
import { useOperators } from "@/modules/operators/hooks/useOperators";
import { useCreateFollowUp, useUpdateFollowUp } from "../hooks/useFollowUps";
import type {
	CreateFollowUpRequest,
	FollowUpStatus,
	FollowUpTask,
	UpdateFollowUpRequest,
} from "../types";
import { FOLLOW_UP_STATUS_CONFIG, FOLLOW_UP_STATUS_ORDER } from "./FollowUpStatusTag";

interface Props {
	open: boolean;
	/** Tahrirlash uchun mavjud vazifa; bo'lmasa yangi yaratiladi */
	task?: FollowUpTask | null;
	/** Boshlang'ich bog'lanishlar (qo'ng'iroq sahifasidan chaqirilganda) */
	defaults?: {
		callId?: string;
		ticketId?: string;
		contactId?: string;
	};
	onClose: () => void;
}

interface FormValues {
	title: string;
	description?: string;
	dueAt?: Dayjs | null;
	contactId?: string;
	assignedTo?: string;
	status?: FollowUpStatus;
}

export function FollowUpFormModal({ open, task, defaults, onClose }: Props) {
	const [form] = Form.useForm<FormValues>();
	const createTask = useCreateFollowUp();
	const updateTask = useUpdateFollowUp();
	const { data: operatorsData, isLoading: isLoadingOperators } = useOperators({ limit: 100 });
	const { data: contactsData, isLoading: isLoadingContacts } = useContacts({ limit: 100 });

	const isEdit = Boolean(task);

	useEffect(() => {
		if (!open) {
			return;
		}
		form.resetFields();
		if (task) {
			form.setFieldsValue({
				title: task.title,
				description: task.description ?? undefined,
				dueAt: task.dueAt ? dayjs(task.dueAt) : null,
				contactId: task.contactId ?? undefined,
				assignedTo: task.assignedTo ?? undefined,
				status: task.status,
			});
		} else {
			form.setFieldsValue({
				contactId: defaults?.contactId,
				status: "open",
			});
		}
	}, [open, task, defaults?.contactId, form]);

	const operatorOptions = (operatorsData?.data.items ?? []).map((operator) => ({
		value: operator.id,
		label: `${operator.extension} — ${operator.user?.phone ?? "Operator"}`,
	}));

	const contactOptions = (contactsData?.data.items ?? []).map((contact) => ({
		value: contact.id,
		label: `${[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Noma'lum"} — ${contact.phoneNumber}`,
	}));

	const toUpdatePayload = (values: FormValues): UpdateFollowUpRequest => ({
		title: values.title,
		description: values.description?.trim() ? values.description.trim() : null,
		dueAt: values.dueAt ? values.dueAt.toISOString() : null,
		status: values.status,
		assignedTo: values.assignedTo ?? null,
	});

	const toCreatePayload = (values: FormValues): CreateFollowUpRequest => ({
		title: values.title,
		description: values.description?.trim() || undefined,
		dueAt: values.dueAt ? values.dueAt.toISOString() : undefined,
		contactId: values.contactId || undefined,
		assignedTo: values.assignedTo || undefined,
		callId: defaults?.callId,
		ticketId: defaults?.ticketId,
	});

	const handleSubmit = async (values: FormValues) => {
		try {
			if (task) {
				await updateTask.mutateAsync({ id: task.id, data: toUpdatePayload(values) });
			} else {
				await createTask.mutateAsync(toCreatePayload(values));
			}
			onClose();
		} catch {
			// Xato hook ichida ko'rsatiladi
		}
	};

	return (
		<Modal
			open={open}
			title={isEdit ? "Vazifani tahrirlash" : "Yangi keyingi aloqa vazifasi"}
			onCancel={onClose}
			onOk={() => form.submit()}
			okText={isEdit ? "Saqlash" : "Yaratish"}
			cancelText="Bekor qilish"
			confirmLoading={createTask.isPending || updateTask.isPending}
			destroyOnHidden
			centered
			width={640}
		>
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
						placeholder="Masalan: Mijozga qayta qo'ng'iroq qilish"
						className="h-12 rounded-xl border-slate-200 bg-slate-50"
					/>
				</Form.Item>

				<Form.Item
					name="description"
					label={
						<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
							Izoh
						</span>
					}
				>
					<Input.TextArea
						rows={4}
						placeholder="Nima qilinishi kerak?"
						className="rounded-2xl border-slate-200 bg-slate-50"
					/>
				</Form.Item>

				<div className="flex flex-col gap-4 md:flex-row">
					<Form.Item
						name="dueAt"
						label={
							<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
								Muddat
							</span>
						}
						className="flex-1"
					>
						<DatePicker
							showTime
							format="YYYY-MM-DD HH:mm"
							placeholder="Muddatni tanlang"
							className="h-12 w-full rounded-xl border-slate-200 bg-slate-50"
						/>
					</Form.Item>

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
				</div>

				<div className="flex flex-col gap-4 md:flex-row">
					{!isEdit && (
						<Form.Item
							name="contactId"
							label={
								<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
									Mijoz
								</span>
							}
							className="flex-1"
						>
							<Select<string>
								allowClear
								showSearch
								optionFilterProp="label"
								placeholder="Mijozni tanlang"
								loading={isLoadingContacts}
								options={contactOptions}
								className="custom-select h-12 w-full"
							/>
						</Form.Item>
					)}

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
							<Select<FollowUpStatus>
								options={FOLLOW_UP_STATUS_ORDER.map((status) => ({
									value: status,
									label: FOLLOW_UP_STATUS_CONFIG[status].label,
								}))}
								className="custom-select h-12 w-full"
							/>
						</Form.Item>
					)}
				</div>
			</Form>
		</Modal>
	);
}
