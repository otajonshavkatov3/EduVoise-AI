import {
	CheckCircleOutlined,
	ClockCircleOutlined,
	CloseOutlined,
	EditOutlined,
	PhoneOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Avatar, Button, Form, Input, Modal, Select, Space, Tag, Typography } from "antd";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { useUpdateTicket } from "../hooks/useTickets";
import type { TicketItem, UpdateTicketRequest } from "../types";
import { priorityConfig } from "./TicketPriorityTag";
import { statusConfig } from "./TicketStatusBadge";

const { Text, Title } = Typography;

interface Props {
	open: boolean;
	ticket: TicketItem | null;
	onCancel: () => void;
}

export interface TicketEditHandle {
	submit: () => void;
}

export const TicketEditModal = forwardRef<TicketEditHandle, Props>(
	({ open, ticket, onCancel }, ref) => {
		const [form] = Form.useForm();
		const updateTicket = useUpdateTicket();

		useImperativeHandle(ref, () => ({
			submit: () => {
				form.submit();
			},
		}));

		useEffect(() => {
			if (ticket && open) {
				form.setFieldsValue({
					subject: ticket.subject,
					description: ticket.description,
					category: ticket.category,
					priority: ticket.priority,
					status: ticket.status,
				});
			}
		}, [ticket, form, open]);

		const handleSubmit = async (values: UpdateTicketRequest) => {
			if (!ticket) {
				return;
			}
			try {
				await updateTicket.mutateAsync({ id: ticket.id, data: values });
				onCancel();
			} catch {
				// Handled by hook
			}
		};

		return (
			<Modal
				title={
					<div className="flex items-center gap-4 pt-4 px-2">
						<div className="w-12 h-12 rounded-2xl bg-linear-to-br from-amber-400 to-orange-500 flex items-center justify-center shrink-0 shadow-lg shadow-orange-500/20">
							<EditOutlined className="text-white text-xl" />
						</div>
						<div>
							<h2 className="m-0 text-xl font-black text-slate-900 tracking-tight leading-none">
								Murojaatni tahrirlash
							</h2>
							<p className="m-0 text-sm font-medium text-slate-500 mt-1.5">
								Murojaat holati va ma'lumotlarini yangilash
							</p>
						</div>
					</div>
				}
				open={open}
				onCancel={onCancel}
				footer={null}
				width={850}
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
					className="ticket-edit-advanced-form"
				>
					<div className="flex flex-col lg:flex-row gap-8">
						{/* Main Content */}
						<div className="flex-1 space-y-6">
							{/* Customer Info Context */}
							<div className="bg-linear-to-r from-slate-50 to-white border border-slate-100/50 rounded-[24px] p-6 flex items-center justify-between shadow-xs">
								<div className="flex items-center gap-4">
									<Avatar
										size={54}
										icon={<UserOutlined />}
										className="bg-blue-100 text-blue-600 border-2 border-white shadow-sm"
									/>
									<div>
										<div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-0.5">
											Murojaatchi
										</div>
										<Title level={5} className="m-0! font-black text-slate-900 leading-none">
											{ticket?.contact?.firstName} {ticket?.contact?.lastName}
										</Title>
										<div className="flex items-center gap-1.5 mt-1.5">
											<PhoneOutlined className="text-blue-500 text-xs" />
											<Text className="text-xs font-bold text-slate-500">
												{ticket?.contact?.phoneNumber}
											</Text>
										</div>
									</div>
								</div>
								<div className="text-right">
									<div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
										Yaratilgan sana
									</div>
									<Tag
										icon={<ClockCircleOutlined />}
										className="rounded-lg font-bold px-3 py-0.5 border-slate-100 bg-white"
									>
										{ticket &&
											new Date(ticket.createdAt).toLocaleDateString("uz-UZ", {
												month: "short",
												day: "numeric",
												hour: "2-digit",
												minute: "2-digit",
											})}
									</Tag>
								</div>
							</div>

							{/* Subject Field */}
							<Form.Item
								name="subject"
								label={
									<Space>
										<span className="font-black text-slate-800 uppercase tracking-wider text-[11px]">
											Murojaat mavzusi
										</span>
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
									placeholder="Yangi ma'lumotlarni qo'shing yoki mavjudini tahrirlang..."
									rows={8}
									className="rounded-3xl pt-5 px-6 bg-slate-50 border-slate-200 hover:border-blue-400 focus:border-blue-500 font-medium transition-all resize-none shadow-sm"
								/>
							</Form.Item>
						</div>

						{/* Sidebar Meta */}
						<div className="w-full lg:w-72 space-y-6">
							{/* Status & Priority Selection */}
							<div className="bg-white border border-slate-100 shadow-sm rounded-[32px] p-6 space-y-6">
								<Form.Item
									name="status"
									label={
										<span className="font-black text-slate-800 uppercase tracking-wider text-[11px]">
											Holati
										</span>
									}
									className="mb-0"
								>
									<Select
										placeholder="Holatni tanlang"
										className="h-12 w-full custom-meta-select"
										options={Object.entries(statusConfig).map(([val, cfg]) => ({
											label: (
												<div className="flex items-center gap-2 font-bold">
													<div
														className="w-2.5 h-2.5 rounded-full"
														style={{
															background:
																cfg.color === "processing"
																	? "#3b82f6"
																	: cfg.color === "success"
																		? "#22c55e"
																		: cfg.color === "error"
																			? "#ef4444"
																			: "#94a3b8",
														}}
													/>
													{cfg.label}
												</div>
											),
											value: val,
										}))}
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
														className="w-2.5 h-2.5 rounded-full"
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
							</div>

							{/* Quick Controls */}
							<div className="pt-4 flex flex-col gap-3">
								<Button
									type="primary"
									htmlType="submit"
									size="large"
									icon={<CheckCircleOutlined />}
									loading={updateTicket.isPending}
									className="h-14 w-full rounded-2xl font-black bg-linear-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 border-none shadow-lg shadow-blue-500/30 text-base"
								>
									YANGILASH
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
				.ticket-edit-advanced-form .ant-form-item-label {
					padding-bottom: 8px !important;
				}
				.custom-meta-select .ant-select-selector {
					border-radius: 16px !important;
					height: 48px !important;
					padding: 8px 16px !important;
					background-color: #f8fafc !important;
					border: 1px solid #e2e8f0 !important;
					transition: all 0.2s;
				}
				.custom-meta-select.ant-select-focused .ant-select-selector {
					border-color: #3b82f6 !important;
					background-color: #fff !important;
					box-shadow: 0 0 0 4px rgba(59,130,246,0.1) !important;
				}
			`}</style>
			</Modal>
		);
	}
);
