import {
	ArrowLeftOutlined,
	CalendarOutlined,
	ClockCircleOutlined,
	DeleteOutlined,
	EnvironmentOutlined,
	PhoneOutlined,
	TagsOutlined,
	UserOutlined,
} from "@ant-design/icons";
import {
	Alert,
	Avatar,
	Button,
	Card,
	Empty,
	List,
	Pagination,
	Popconfirm,
	Skeleton,
	Space,
	Tabs,
	Tag,
	Tooltip,
	Typography,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCalls } from "@/modules/calls/hooks/useCalls";
import { useSipPhoneContext } from "@/modules/calls/providers/SipPhoneProvider";
import type { Call } from "@/modules/calls/types";
import { priorityConfig } from "@/modules/tickets/components/TicketPriorityTag";
import { statusConfig } from "@/modules/tickets/components/TicketStatusBadge";
import { useRemoveTicket, useTickets } from "@/modules/tickets/hooks/useTickets";
import type { TicketItem } from "@/modules/tickets/types";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { formatDate, formatTime } from "@/shared/utils/datetime";
import { ticketCategoryLabel } from "@/shared/utils/labels";
import { useContact } from "../hooks/useContacts";

const { Title, Text, Paragraph } = Typography;

const PAGE_SIZE = 5;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Contact detail page is a large component displaying multiple related datasets
export default function ContactDetailPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const [callsPage, setCallsPage] = useState(1);
	const [ticketsPage, setTicketsPage] = useState(1);

	const {
		data: contact,
		isLoading: isContactLoading,
		isError: isContactError,
		error: contactError,
		refetch: refetchContact,
	} = useContact(id ?? "", {
		refetchOnWindowFocus: false,
		staleTime: 60000,
	});

	const callsFilters = useMemo(
		() => ({
			phoneNumber: contact?.phoneNumber,
			limit: PAGE_SIZE,
			page: callsPage,
		}),
		[contact?.phoneNumber, callsPage]
	);

	const ticketsFilters = useMemo(
		() => ({
			phoneNumber: contact?.phoneNumber,
			limit: PAGE_SIZE,
			page: ticketsPage,
		}),
		[contact?.phoneNumber, ticketsPage]
	);

	const {
		data: callsResponse,
		isLoading: isCallsLoading,
		isError: isCallsError,
	} = useCalls(callsFilters, !!contact?.phoneNumber, {
		refetchOnWindowFocus: false,
		staleTime: 60000, // 1 minute
	});

	const {
		data: ticketsResponse,
		isLoading: isTicketsLoading,
		isError: isTicketsError,
	} = useTickets(ticketsFilters, !!contact?.phoneNumber, {
		refetchOnWindowFocus: false,
		staleTime: 60000, // 1 minute
	});

	const { mutate: removeTicket } = useRemoveTicket();
	const { makeCall, isRegistered } = useSipPhoneContext();

	const calls = callsResponse?.data.items || [];
	const callsMeta = callsResponse?.data.meta;

	const tickets = ticketsResponse?.data.items || [];
	const ticketsMeta = ticketsResponse?.data.meta;

	const handleDeleteTicket = (ticketId: string, e: React.MouseEvent) => {
		e.stopPropagation();
		removeTicket(ticketId);
	};

	if (isContactLoading) {
		return (
			<div className="p-8">
				<Skeleton active avatar paragraph={{ rows: 10 }} />
			</div>
		);
	}

	// Server xatosi "topilmadi" bilan aralashtirilmaydi.
	if (isContactError) {
		return (
			<div className="animate-fadeIn mx-auto max-w-3xl p-4 md:p-8">
				<Alert
					type="error"
					showIcon
					className="rounded-2xl"
					message="Kontakt ma'lumotlarini yuklab bo'lmadi"
					description={getApiErrorMessage(contactError, "Server bilan aloqa yo'q")}
					action={
						<Space direction="vertical">
							<Button size="small" onClick={() => refetchContact()}>
								Qayta urinish
							</Button>
							<Button size="small" type="link" onClick={() => navigate("/contacts")}>
								Ro'yxatga qaytish
							</Button>
						</Space>
					}
				/>
			</div>
		);
	}

	if (!contact) {
		return (
			<div className="flex flex-col items-center justify-center h-[60vh]">
				<Empty description="Kontakt topilmadi" image={Empty.PRESENTED_IMAGE_SIMPLE} />
				<Button onClick={() => navigate("/contacts")} className="mt-4">
					Orqaga qaytish
				</Button>
			</div>
		);
	}

	return (
		<div className="animate-fadeIn pb-10">
			{/* Header */}
			<div className="flex items-center gap-4 mb-6">
				<Button
					type="text"
					icon={<ArrowLeftOutlined />}
					onClick={() => navigate("/contacts")}
					className="flex items-center gap-2 font-medium text-slate-500 hover:text-slate-900 transition-colors"
				>
					Orqaga
				</Button>
				<Title level={4} style={{ margin: 0 }}>
					Kontakt tafsilotlari
				</Title>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
				{/* Left Column: Profile Card */}
				<div className="lg:col-span-4 space-y-6">
					<Card className="border-none shadow-sm rounded-3xl overflow-hidden bg-white/50 backdrop-blur-sm">
						<div className="flex flex-col items-center text-center pb-8 pt-4">
							<Avatar
								size={120}
								icon={<UserOutlined />}
								className="bg-gradient-to-br from-blue-600 to-indigo-700 text-3xl font-bold mb-4 shadow-xl shadow-blue-500/20"
							>
								{contact.firstName?.[0] || contact.phoneNumber?.[0]}
								{contact.lastName?.[0] || ""}
							</Avatar>
							<Title level={3} className="mb-1!">
								{contact.firstName || "Noma'lum"} {contact.lastName || ""}
							</Title>
							<Text type="secondary" className="text-slate-400 font-medium">
								Mijoz ID: {contact.id.slice(0, 8)}...
							</Text>
						</div>

						<div className="space-y-6 px-2">
							<div className="flex items-start gap-4 p-3 rounded-2xl hover:bg-slate-50 transition-colors">
								<div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
									<PhoneOutlined className="text-blue-500" />
								</div>
								<div>
									<div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
										Telefon raqami
									</div>
									<div className="font-bold text-slate-900">{contact.phoneNumber}</div>
								</div>
							</div>

							<div className="flex items-start gap-4 p-3 rounded-2xl hover:bg-slate-50 transition-colors">
								<div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center shrink-0">
									<EnvironmentOutlined className="text-purple-500" />
								</div>
								<div>
									<div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
										Manzil
									</div>
									<div className="font-bold text-slate-900">
										{contact.address?.tuman ? (
											<>
												{contact.address.tuman} tumani, {contact.address.kocha} ko'chasi,{" "}
												{contact.address.uy}-uy
											</>
										) : (
											"Ko'rsatilmagan"
										)}
									</div>
								</div>
							</div>

							<div className="flex items-start gap-4 p-3 rounded-2xl hover:bg-slate-50 transition-colors">
								<div className="w-10 h-10 rounded-xl bg-orange-50 flex items-center justify-center shrink-0">
									<CalendarOutlined className="text-orange-500" />
								</div>
								<div>
									<div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
										Qo'shilgan sana
									</div>
									<div className="font-bold text-slate-900">{formatDate(contact.createdAt)}</div>
								</div>
							</div>
						</div>

						<div className="grid grid-cols-2 gap-4 mt-8">
							<div className="bg-slate-50/50 p-4 rounded-2xl text-center border border-slate-100">
								<div className="text-2xl font-black text-slate-900 leading-none mb-1">
									{contact.callsCount ?? callsMeta?.total ?? 0}
								</div>
								<div className="text-[10px] font-bold text-slate-400 uppercase">Qo'ng'iroqlar</div>
							</div>
							<div className="bg-slate-50/50 p-4 rounded-2xl text-center border border-slate-100">
								<div className="text-2xl font-black text-slate-900 leading-none mb-1">
									{contact.ticketsCount ?? ticketsMeta?.total ?? 0}
								</div>
								<div className="text-[10px] font-bold text-slate-400 uppercase">Murojaatlar</div>
							</div>
						</div>

						{/* Tugma SIP telefonga ulangan: avval u hech qanday amal
						    bajarmasdan shunchaki turardi. Registratsiya bo'lmasa
						    o'chirilgan holatda va sababi tooltipda ko'rsatiladi. */}
						<Tooltip
							title={
								isRegistered
									? `${contact.phoneNumber} raqamiga qo'ng'iroq qilish`
									: "SIP telefon ro'yxatdan o'tmagan — qo'ng'iroq qilish mumkin emas"
							}
						>
							<Button
								type="primary"
								size="large"
								block
								icon={<PhoneOutlined />}
								disabled={!isRegistered}
								onClick={() => makeCall(contact.phoneNumber)}
								className="h-14 rounded-2xl bg-blue-600 hover:bg-blue-700! border-none font-bold mt-8 shadow-lg shadow-blue-600/20 flex items-center justify-center gap-3"
							>
								Qo'ng'iroq qilish
							</Button>
						</Tooltip>
					</Card>
				</div>

				{/* Right Column: Content Tabs */}
				<div className="lg:col-span-8">
					<Card className="border-none shadow-sm rounded-3xl h-full min-h-[600px] overflow-hidden flex flex-col">
						<Tabs
							defaultActiveKey="calls"
							className="custom-tabs contact-detail-tabs flex-1"
							items={[
								{
									key: "calls",
									label: (
										<span className="flex items-center gap-2 px-4 py-2">
											<ClockCircleOutlined /> Qo'ng'iroqlar ({callsMeta?.total ?? 0})
										</span>
									),
									children: (
										<div className="p-2 pt-4">
											<Title level={4} className="mb-6 px-2">
												Qo'ng'iroqlar tarixi
											</Title>
											{isCallsError && (
												<Alert
													type="error"
													showIcon
													className="mb-4 rounded-2xl"
													message="Qo'ng'iroqlar tarixini yuklab bo'lmadi"
												/>
											)}
											<List
												loading={isCallsLoading}
												dataSource={calls}
												locale={{
													emptyText: (
														<Empty
															image={Empty.PRESENTED_IMAGE_SIMPLE}
															description={
																isCallsError ? "Ma'lumot yuklanmadi" : "Qo'ng'iroqlar topilmadi"
															}
															className="py-10"
														/>
													),
												}}
												renderItem={(call: Call) => (
													<List.Item className="px-0 border-none mb-4">
														<div className="w-full p-6 rounded-3xl border border-slate-100 bg-white hover:border-blue-200 transition-all hover:shadow-md group">
															<div className="flex items-start justify-between mb-4">
																<div className="flex items-center gap-4">
																	<div
																		className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-transform group-hover:scale-110 ${
																			call.direction === "inbound"
																				? "bg-blue-50 text-blue-600"
																				: "bg-emerald-50 text-emerald-600"
																		}`}
																	>
																		<PhoneOutlined
																			className={call.direction === "outbound" ? "rotate-90" : ""}
																		/>
																	</div>
																	<div>
																		<div className="font-bold text-slate-900 uppercase text-[11px] tracking-widest mb-0.5">
																			{call.direction === "inbound" ? "Kiruvchi" : "Chiquvchi"}
																		</div>
																		<div className="flex items-center gap-3 text-slate-400 text-xs">
																			<span className="flex items-center gap-1.5 font-medium">
																				<CalendarOutlined className="text-[12px]" />
																				{formatDate(call.startedAt)}
																			</span>
																			<span className="flex items-center gap-1.5 font-medium">
																				<ClockCircleOutlined className="text-[12px]" />
																				{formatTime(call.startedAt)}
																			</span>
																		</div>
																	</div>
																</div>
																<Tag
																	color={
																		call.status === "completed"
																			? "success"
																			: call.status === "missed"
																				? "error"
																				: "processing"
																	}
																	className="rounded-full px-4 border-none font-bold text-[10px] uppercase py-0.5"
																>
																	{call.status}
																</Tag>
															</div>
															{call.duration && (
																<div className="text-slate-500 text-sm font-medium">
																	Davomiyligi: {Math.floor(call.duration / 60)}m{" "}
																	{call.duration % 60}s
																</div>
															)}
														</div>
													</List.Item>
												)}
											/>
											{callsMeta && callsMeta.totalPages > 1 && (
												<div className="mt-8 flex justify-center pb-4">
													<Pagination
														current={callsPage}
														total={callsMeta.total}
														pageSize={PAGE_SIZE}
														onChange={(page) => setCallsPage(page)}
														showSizeChanger={false}
														className="custom-pagination"
													/>
												</div>
											)}
										</div>
									),
								},
								{
									key: "tickets",
									label: (
										<span className="flex items-center gap-2 px-4 py-2">
											<TagsOutlined /> Murojaatlar ({ticketsMeta?.total ?? 0})
										</span>
									),
									children: (
										<div className="p-2 pt-4">
											<div className="flex items-center justify-between mb-6 px-2">
												<Title level={4} style={{ margin: 0 }}>
													Mijoz murojaatlari
												</Title>
											</div>
											{isTicketsError && (
												<Alert
													type="error"
													showIcon
													className="mb-4 rounded-2xl"
													message="Murojaatlarni yuklab bo'lmadi"
												/>
											)}
											<List
												loading={isTicketsLoading}
												dataSource={tickets}
												locale={{
													emptyText: (
														<Empty
															image={Empty.PRESENTED_IMAGE_SIMPLE}
															description={
																isTicketsError ? "Ma'lumot yuklanmadi" : "Murojaat topilmadi"
															}
															className="py-10"
														/>
													),
												}}
												renderItem={(ticket: TicketItem) => (
													<List.Item className="px-0 border-none mb-4">
														<div className="relative group">
															<button
																type="button"
																className="w-full p-6 text-left rounded-3xl border border-slate-100 bg-white hover:border-indigo-200 transition-all hover:shadow-md cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
																onClick={() => navigate(`/tickets/${ticket.id}`)}
																aria-label={`«${ticket.subject}» murojaatini ochish`}
															>
																<div className="flex items-start justify-between mb-3">
																	<div className="flex-1 pr-12">
																		<div className="flex items-center gap-2 mb-1">
																			<span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
																				#{ticket.id.slice(-6).toUpperCase()}
																			</span>
																			<Tag
																				color={
																					ticket.status === "resolved"
																						? "success"
																						: ticket.status === "closed"
																							? "default"
																							: "blue"
																				}
																				className="rounded-full px-3 border-none font-bold text-[9px] uppercase"
																			>
																				{statusConfig[ticket.status].label}
																			</Tag>
																		</div>
																		<Title level={5} className="m-0! mb-1!">
																			{ticket.subject}
																		</Title>
																	</div>
																	<Tag
																		color={
																			ticket.priority === "high"
																				? "red"
																				: ticket.priority === "medium"
																					? "orange"
																					: "blue"
																		}
																		className="rounded-lg border-none font-bold text-[10px] uppercase"
																	>
																		{priorityConfig[ticket.priority].label}
																	</Tag>
																</div>
																<Paragraph className="text-slate-500 text-sm mb-4 line-clamp-2">
																	{ticket.description}
																</Paragraph>
																<div className="flex items-center justify-between pt-4 border-t border-slate-50">
																	<div className="text-xs text-slate-400 flex items-center gap-2">
																		<CalendarOutlined />
																		{formatDate(ticket.createdAt)}
																	</div>
																	{ticket.category && (
																		<Tag className="m-0 rounded-full bg-slate-100 border-none text-slate-600 font-medium text-[10px]">
																			{ticketCategoryLabel(ticket.category)}
																		</Tag>
																	)}
																</div>
															</button>

															<div className="absolute top-6 right-6 flex items-center gap-2 z-10">
																<Popconfirm
																	title="Murojaatni o'chirib tashlamoqchimisiz?"
																	onConfirm={(e) => e && handleDeleteTicket(ticket.id, e)}
																	onCancel={(e) => e?.stopPropagation()}
																	okText="Ha"
																	cancelText="Yo'q"
																	okButtonProps={{ danger: true }}
																>
																	<Button
																		type="text"
																		danger
																		icon={<DeleteOutlined />}
																		className="opacity-0 group-hover:opacity-100 transition-opacity"
																		onClick={(e) => e.stopPropagation()}
																	/>
																</Popconfirm>
															</div>
														</div>
													</List.Item>
												)}
											/>
											{ticketsMeta && ticketsMeta.totalPages > 1 && (
												<div className="mt-8 flex justify-center pb-4">
													<Pagination
														current={ticketsPage}
														total={ticketsMeta.total}
														pageSize={PAGE_SIZE}
														onChange={(page) => setTicketsPage(page)}
														showSizeChanger={false}
														className="custom-pagination"
													/>
												</div>
											)}
										</div>
									),
								},
							]}
						/>
					</Card>
				</div>
			</div>
		</div>
	);
}
