import {
	CheckCircleOutlined,
	ClockCircleOutlined,
	CloseOutlined,
	InfoCircleOutlined,
	PhoneOutlined,
	SearchOutlined,
	TagsOutlined,
	UserAddOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Avatar, Button, Form, Input, Modal, Select, Space, Tag, Tooltip, Typography } from "antd";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { IncomingCall } from "@/modules/calls/store/callPop.store";
import { CALL_POP_STATUS_LABELS } from "@/modules/calls/utils/callStatus";
import { useContacts, useCreateContact } from "@/modules/contacts/hooks/useContacts";
import { formatTime } from "@/shared/utils/datetime";
import { useCreateTicket } from "../hooks/useTickets";
import { priorityConfig } from "./TicketPriorityTag";

const { Text } = Typography;

interface Props {
	open: boolean;
	onCancel: () => void;
	initialContactId?: string;
	/** Pre-fill phone number when no contact exists — puts form in 'new contact' mode */
	initialPhoneNumber?: string;
	call?: IncomingCall;
}

export interface TicketCreateHandle {
	submit: () => void;
}

export const TicketCreateModal = forwardRef<TicketCreateHandle, Props>(
	({ open, onCancel, initialContactId, initialPhoneNumber, call }, ref) => {
		const [form] = Form.useForm();
		const createTicket = useCreateTicket();
		const createContact = useCreateContact();
		const { data: contactsData, isLoading: isLoadingContacts } = useContacts({ limit: 100 });
		// If there's a pre-filled phone (no contact found), default to 'new contact' mode
		const [isNewContact, setIsNewContact] = useState(!initialContactId);

		useImperativeHandle(ref, () => ({
			submit: () => {
				form.submit();
			},
		}));

		useEffect(() => {
			if (open) {
				if (initialContactId) {
					// Contact found — link existing contact
					setIsNewContact(false);
					form.resetFields();
					form.setFieldsValue({ priority: "medium", contactId: initialContactId });
				} else {
					// No contact found — pre-fill phone and stay in 'new contact' mode
					setIsNewContact(true);
					form.resetFields();
					form.setFieldsValue({ priority: "medium" });
					if (initialPhoneNumber) {
						form.setFieldsValue({ phoneNumber: initialPhoneNumber });
					}
				}

				if (call) {
					const direction = call.direction === "inbound" ? "Kiruvchi" : "Chiquvchi";
					const number = call.direction === "inbound" ? call.callerNumber : call.calleeExtension;
					form.setFieldsValue({
						subject: `[${direction}] Qo'ng'iroq: ${number}`,
						description: call.contact?.notes ? `Mijoz eslatmasi: ${call.contact.notes}\n\n` : "",
						// Only set phoneNumber if we haven't already set it from initialPhoneNumber
						...(initialContactId || initialPhoneNumber ? {} : { phoneNumber: number }),
					});
				}
			}
		}, [open, initialContactId, initialPhoneNumber, form, call]);

		const handleSubmit = async (values: any) => {
			try {
				let contactId = values.contactId;

				// If it's a new contact, create it first
				if (isNewContact) {
					const contact = await createContact.mutateAsync({
						firstName: values.firstName,
						lastName: values.lastName,
						phoneNumber: values.phoneNumber,
					});
					contactId = contact.id;
				}

				if (!contactId) {
					throw new Error("Mijoz tanlanmagan");
				}

				await createTicket.mutateAsync({
					contactId,
					subject: values.subject,
					description: values.description,
					category: values.category,
					priority: values.priority,
				});

				onCancel();
				form.resetFields();
			} catch {
				// Handled by hook
			}
		};

		const contactOptions =
			contactsData?.data.items.map((contact) => ({
				label: (
					<div className="flex items-center gap-3 py-1 text-left">
						<Avatar size={32} icon={<UserOutlined />} className="bg-blue-100 text-blue-600" />
						<div className="flex flex-col text-left">
							<span className="font-bold text-slate-800 leading-tight">
								{contact.firstName || contact.lastName
									? `${contact.firstName || ""} ${contact.lastName || ""}`.trim()
									: "Noma'lum mijoz"}
							</span>
							<span className="text-[11px] font-medium text-slate-500">{contact.phoneNumber}</span>
						</div>
					</div>
				),
				value: contact.id,
				searchStr: `${contact.phoneNumber} ${contact.firstName} ${contact.lastName}`,
			})) || [];

		return (
			<Modal
				title={
					<div className="flex items-center gap-4 pt-4 px-2">
						<div className="w-12 h-12 rounded-2xl bg-linear-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0 shadow-lg shadow-blue-500/20">
							<TagsOutlined className="text-white text-xl" />
						</div>
						<div>
							<h2 className="m-0 text-xl font-black text-slate-900 tracking-tight leading-none">
								Yangi murojaat yaratish
							</h2>
							<p className="m-0 text-sm font-medium text-slate-500 mt-1.5">
								Mijoz murojaatini ro'yxatga olish
							</p>
						</div>
					</div>
				}
				open={open}
				onCancel={onCancel}
				footer={null}
				width={900}
				centered
				destroyOnClose
				closeIcon={
					<div className="w-10 h-10 rounded-full bg-slate-50 flex items-center justify-center hover:bg-slate-100 transition-all hover:rotate-90 mt-4 mr-4">
						<CloseOutlined className="text-slate-500" />
					</div>
				}
				styles={{
					mask: { backdropFilter: "blur(8px)", background: "rgba(15,23,42,0.6)" },
					body: { padding: "0 32px 32px" },
					header: {
						padding: "0",
						borderBottom: "none",
						marginBottom: "24px",
					},
				}}
			>
				<Form
					form={form}
					layout="vertical"
					onFinish={handleSubmit}
					requiredMark={false}
					initialValues={{ priority: "medium" }}
					className="ticket-create-advanced-form"
				>
					<div className="flex flex-col lg:flex-row gap-8">
						{/* Main Content */}
						<div className="flex-1 space-y-6">
							{/* Call Context Banner */}
							{call && (
								<div className="bg-linear-to-r from-blue-50 to-indigo-50 border border-blue-100/50 rounded-[24px] p-5 relative overflow-hidden">
									<div className="absolute top-0 right-0 p-4 opacity-10">
										<PhoneOutlined className="text-6xl text-blue-600 rotate-12" />
									</div>
									<div className="relative z-10 flex flex-wrap gap-4 items-center">
										<div className="bg-white/80 backdrop-blur-sm px-4 py-2 rounded-xl border border-blue-100 shadow-sm flex items-center gap-2">
											<PhoneOutlined className="text-blue-500" />
											<Text className="font-black text-blue-700">
												{call.direction === "inbound" ? call.callerNumber : call.calleeExtension}
											</Text>
										</div>
										<div className="flex items-center gap-2">
											<Tag
												color="blue"
												className="rounded-lg font-bold border-none px-3 uppercase text-[10px]"
											>
												{CALL_POP_STATUS_LABELS[call.status]}
											</Tag>
											<Tag
												icon={<ClockCircleOutlined />}
												className="rounded-lg font-bold px-3 text-[10px]"
											>
												{formatTime(call.startedAt)}
											</Tag>
										</div>
									</div>
								</div>
							)}

							{/* Subject Field */}
							<Form.Item
								name="subject"
								label={
									<Space>
										<span className="font-black text-slate-800 uppercase tracking-wider text-[11px]">
											Murojaat mavzusi
										</span>
										<Tooltip title="Muammoning qisqacha mazmuni">
											<InfoCircleOutlined className="text-slate-400 text-[12px]" />
										</Tooltip>
									</Space>
								}
								rules={[{ required: true, message: "Mavzu kiritilishi shart!" }]}
							>
								<Input
									placeholder="Masalan: Internet ulanishi muammosi"
									className="h-14 rounded-2xl bg-slate-50 border-slate-200 hover:border-blue-400 focus:border-blue-500 focus:shadow-[0_0_0_4px_rgba(59,130,246,0.1)] px-5 font-bold text-lg transition-all"
								/>
							</Form.Item>

							{/* Description Field */}
							<Form.Item
								name="description"
								label={
									<span className="font-black text-slate-800 uppercase tracking-wider text-[11px]">
										Batafsil ma'lumot
									</span>
								}
								rules={[{ required: true, message: "Batafsil ma'lumot kiritilishi shart!" }]}
							>
								<Input.TextArea
									placeholder="Mijozning muammosini, talablarini va joriy holatni batafsil yozing..."
									rows={8}
									className="rounded-3xl pt-5 px-6 bg-slate-50 border-slate-200 hover:border-blue-400 focus:border-blue-500 font-medium transition-all resize-none shadow-sm"
								/>
							</Form.Item>
						</div>

						{/* Sidebar Meta */}
						<div className="w-full lg:w-80 space-y-6">
							{/* Contact Section */}
							<div className="bg-slate-50 border border-slate-100 rounded-[32px] p-6 space-y-4 shadow-sm">
								<div className="flex items-center justify-between mb-2">
									<div className="flex items-center gap-2">
										<UserOutlined className="text-blue-500" />
										<span className="font-black text-slate-800 uppercase tracking-wider text-[11px]">
											{isNewContact ? "Yangi mijoz" : "Mavjud mijoz"}
										</span>
									</div>
									<Button
										type="text"
										size="small"
										icon={isNewContact ? <SearchOutlined /> : <UserAddOutlined />}
										onClick={() => setIsNewContact(!isNewContact)}
										className="text-blue-500 hover:text-blue-600 font-bold text-[11px]"
									>
										{isNewContact ? "Qidirish" : "Yangi qo'shish"}
									</Button>
								</div>

								{isNewContact ? (
									<div className="space-y-4 animate-in fade-in slide-in-from-right-2 duration-300">
										<Form.Item
											name="firstName"
											rules={[{ required: isNewContact, message: "Ism majburiy!" }]}
											className="mb-0"
										>
											<Input
												prefix={<UserOutlined className="text-slate-300" />}
												placeholder="Ismi"
												className="h-12 rounded-xl"
											/>
										</Form.Item>
										<Form.Item name="lastName" className="mb-0">
											<Input placeholder="Familiyasi" className="h-12 rounded-xl" />
										</Form.Item>
										<Form.Item
											name="phoneNumber"
											rules={[{ required: isNewContact, message: "Telefon raqami majburiy!" }]}
											className="mb-0"
										>
											<Input
												prefix={<PhoneOutlined className="text-slate-300" />}
												placeholder="Telefon raqami"
												className="h-12 rounded-xl"
											/>
										</Form.Item>
									</div>
								) : (
									<Form.Item
										name="contactId"
										rules={[{ required: !isNewContact, message: "Mijozni tanlash majburiy!" }]}
										className="mb-0 animate-in fade-in slide-in-from-left-2 duration-300"
									>
										<Select
											className="h-12 custom-side-select w-full"
											placeholder="Mijozni tanlang"
											showSearch
											options={contactOptions}
											loading={isLoadingContacts}
											filterOption={(input, option) =>
												(option?.searchStr as string)?.toLowerCase().includes(input.toLowerCase())
											}
											popupClassName="ticket-select-popup rounded-2xl p-2"
										/>
									</Form.Item>
								)}
							</div>

							{/* Metadata Selects */}
							<div className="bg-white border border-slate-100 shadow-sm rounded-[32px] p-6 space-y-6">
								<Form.Item
									name="category"
									label={
										<span className="font-black text-slate-800 uppercase tracking-wider text-[11px]">
											Turkum
										</span>
									}
									className="mb-0"
								>
									<Select
										placeholder="Tanlang"
										className="h-12 w-full custom-meta-select"
										options={[
											{ label: "🛠️ Texnik yordam", value: "Technical" },
											{ label: "💰 Moliyaviy / To'lov", value: "Billing" },
											{ label: "❌ Shikoyat", value: "Complaint" },
											{ label: "💡 Taklif / Fikr", value: "Feedback" },
											{ label: "❓ Boshqa", value: "Other" },
										]}
									/>
								</Form.Item>

								<Form.Item
									name="priority"
									label={
										<span className="font-black text-slate-800 uppercase tracking-wider text-[11px]">
											Muhimlik
										</span>
									}
									className="mb-0"
								>
									<Select
										className="h-12 w-full custom-meta-select"
										options={Object.entries(priorityConfig).map(([val, cfg]) => ({
											label: (
												<div className="flex items-center gap-2 font-bold">
													<div
														className={`w-2.5 h-2.5 rounded-full`}
														style={{
															background:
																cfg.color === "gold"
																	? "#eab308"
																	: cfg.color === "cyan"
																		? "#06b6d4"
																		: "#ef4444",
														}}
													/>
													{val.toUpperCase()}
												</div>
											),
											value: val,
										}))}
									/>
								</Form.Item>
							</div>

							{/* Quick Controls */}
							<div className="pt-4 flex flex-col gap-3">
								<Button
									type="primary"
									htmlType="submit"
									size="large"
									icon={<CheckCircleOutlined />}
									loading={createTicket.isPending || createContact.isPending}
									className="h-14 w-full rounded-2xl font-black bg-linear-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 border-none shadow-lg shadow-blue-500/30 text-base"
								>
									MUROJAATNI SAQLASH
								</Button>
								<Button
									onClick={onCancel}
									className="h-12 w-full rounded-2xl font-bold bg-slate-100 text-slate-500 border-none hover:bg-slate-200! hover:text-slate-700"
								>
									Bekor qilish
								</Button>
							</div>
						</div>
					</div>
				</Form>

				<style>{`
				.ticket-create-advanced-form .ant-form-item-label {
					padding-bottom: 8px !important;
				}
				.custom-side-select .ant-select-selector,
				.custom-meta-select .ant-select-selector {
					border-radius: 16px !important;
					height: 48px !important;
					padding: 8px 16px !important;
					background-color: #f8fafc !important;
					border: 1px solid #e2e8f0 !important;
					transition: all 0.2s;
				}
				.custom-side-select.ant-select-focused .ant-select-selector,
				.custom-meta-select.ant-select-focused .ant-select-selector {
					border-color: #3b82f6 !important;
					background-color: #fff !important;
					box-shadow: 0 0 0 4px rgba(59,130,246,0.1) !important;
				}
				.ticket-select-popup {
					border-radius: 20px !important;
					box-shadow: 0 10px 40px rgba(0,0,0,0.1) !important;
					border: 1px solid #f1f5f9 !important;
					padding-top: 8px !important;
				}
				.ticket-select-popup .ant-select-item {
					border-radius: 12px !important;
					margin: 0 8px 4px !important;
					padding: 8px 12px !important;
				}
				.ticket-select-popup .ant-select-item-option-selected {
					background-color: #eff6ff !important;
				}
			`}</style>
			</Modal>
		);
	}
);
