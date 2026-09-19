import {
	ArrowLeftOutlined,
	DownOutlined,
	PhoneOutlined,
	RobotOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Avatar, Button, Card, Dropdown, Empty, Skeleton, Tag, Tooltip, Typography } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import { useSipPhoneContext } from "@/modules/calls/providers/SipPhoneProvider";
import { formatDateTime } from "@/shared/utils/datetime";
import { ticketCategoryLabel } from "@/shared/utils/labels";
import { TicketPriorityTag } from "../components/TicketPriorityTag";
import { statusConfig, TicketStatusBadge } from "../components/TicketStatusBadge";
import { useTicket, useUpdateTicket } from "../hooks/useTickets";
import type { TicketStatus } from "../types";

const { Title, Text, Paragraph } = Typography;

export default function TicketDetailPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { data: ticket, isLoading } = useTicket(id ?? "");
	const updateTicket = useUpdateTicket();
	const { makeCall, isRegistered } = useSipPhoneContext();

	if (isLoading) {
		return (
			<div className="p-8">
				<Skeleton active paragraph={{ rows: 12 }} />
			</div>
		);
	}

	if (!ticket) {
		return (
			<div className="flex flex-col items-center justify-center h-[60vh]">
				<Empty description="Murojaat topilmadi" />
				<Button onClick={() => navigate("/tickets")} className="mt-4">
					Orqaga qaytish
				</Button>
			</div>
		);
	}

	const contactPhone = ticket.contact?.phoneNumber ?? "";

	const statusMenuItems = (Object.keys(statusConfig) as TicketStatus[])
		.filter((status) => status !== ticket.status)
		.map((status) => ({ key: status, label: statusConfig[status].label }));

	return (
		<div className="animate-fadeIn">
			{/* Header */}
			<div className="mb-8">
				<Button
					type="text"
					icon={<ArrowLeftOutlined />}
					onClick={() => navigate("/tickets")}
					className="mb-4 flex items-center gap-2 font-medium text-slate-500 hover:text-slate-900"
				>
					Orqaga
				</Button>

				<Card className="border-none shadow-sm rounded-3xl overflow-hidden">
					<div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
						<div className="flex-1">
							<div className="flex items-center gap-3 mb-2">
								<Text className="text-sm font-bold text-slate-400 uppercase tracking-widest">
									#{ticket.id.slice(0, 8).toUpperCase()}
								</Text>
								<TicketStatusBadge status={ticket.status} />
								<TicketPriorityTag priority={ticket.priority} />
								{ticket.category && (
									<Tag
										color="blue"
										className="rounded-md px-2 border-none font-bold text-[10px] uppercase"
									>
										{ticketCategoryLabel(ticket.category)}
									</Tag>
								)}
							</div>
							<Title
								level={2}
								className="mb-4! text-slate-900! font-black tracking-tight leading-tight"
							>
								{ticket.subject}
							</Title>
							<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-slate-400 text-xs">
								<span className="flex items-center gap-2">
									<UserOutlined /> Operator:{" "}
									<span className="text-slate-600 font-bold">{ticket.creator?.phone || "—"}</span>
								</span>
								<span className="flex items-center gap-2">
									Yaratilgan sana:{" "}
									<span className="text-slate-600 font-bold">
										{formatDateTime(ticket.createdAt)}
									</span>
								</span>
								<span className="flex items-center gap-2">
									Yangilandi:{" "}
									<span className="text-slate-600 font-bold">
										{formatDateTime(ticket.updatedAt)}
									</span>
								</span>
							</div>
						</div>
						<Dropdown
							trigger={["click"]}
							disabled={updateTicket.isPending}
							menu={{
								items: statusMenuItems,
								onClick: ({ key }) => {
									updateTicket.mutate({
										id: ticket.id,
										data: { status: key as TicketStatus },
									});
								},
							}}
						>
							<Button
								type="primary"
								size="large"
								loading={updateTicket.isPending}
								icon={<DownOutlined />}
								className="h-12 px-6 rounded-xl bg-slate-900 hover:bg-slate-800! border-none font-bold shadow-lg shadow-slate-900/10"
							>
								Holatni yangilash
							</Button>
						</Dropdown>
					</div>
				</Card>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
				{/* Left Column */}
				<div className="lg:col-span-8 space-y-8">
					{/* Description */}
					<Card
						title={<span className="font-bold flex items-center gap-2 text-slate-900">Tavsif</span>}
						className="border-none shadow-sm rounded-3xl"
					>
						<Paragraph className="text-slate-600 leading-relaxed text-base">
							{ticket.description}
						</Paragraph>
					</Card>

					{/*
					 * Faqat backend qaytargan `aiSummary` ko'rsatiladi.
					 * Avval bu yerda soxta audio pleyer (qattiq yozilgan 30% va "03:05"),
					 * qattiq yozilgan "Negative" kayfiyat va o'ylab topilgan sakkizta
					 * "asosiy fikr"/"tavsiya" turardi — murojaatlar API'sida bunday
					 * maydonlarning birortasi ham yo'q. Xuddi shu maket bloklari
					 * CallDetailPage'dan allaqachon olib tashlangan edi.
					 */}
					{ticket.aiSummary && (
						<Card
							title={
								<span className="font-bold flex items-center gap-2 text-slate-900">
									<RobotOutlined className="text-blue-500" /> AI xulosasi
								</span>
							}
							className="border-none shadow-sm rounded-3xl"
						>
							<Paragraph className="text-slate-600 leading-relaxed">{ticket.aiSummary}</Paragraph>
						</Card>
					)}
				</div>

				{/* Right Column */}
				<div className="lg:col-span-4">
					<Card
						title={<span className="font-bold text-slate-900">Bog'lanish uchun ma'lumot</span>}
						className="border-none shadow-sm rounded-3xl overflow-hidden sticky top-24"
					>
						<div className="flex items-center gap-4 mb-8">
							<Avatar size={64} className="bg-blue-600 font-bold shadow-lg shadow-blue-500/20">
								{ticket.contact?.firstName?.[0] || "U"}
							</Avatar>
							<div>
								<div className="font-black text-slate-900 text-lg leading-tight">
									{ticket.contact?.firstName} {ticket.contact?.lastName}
								</div>
								<div className="text-slate-400 text-xs font-semibold uppercase tracking-wider mt-1">
									Mijoz
								</div>
							</div>
						</div>

						<div className="space-y-6">
							<div className="flex items-start gap-4">
								<PhoneOutlined className="text-slate-400 mt-1" />
								<div>
									<div className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-1">
										Telefon raqami
									</div>
									<div className="font-bold text-slate-700">{contactPhone || "—"}</div>
								</div>
							</div>
						</div>

						<div className="flex flex-col gap-4 mt-10 w-full">
							<Tooltip
								title={
									isRegistered
										? `${contactPhone} raqamiga qo'ng'iroq qilish`
										: "SIP telefon ro'yxatdan o'tmagan — qo'ng'iroq qilish mumkin emas"
								}
							>
								<Button
									type="primary"
									block
									size="large"
									icon={<PhoneOutlined />}
									disabled={!(isRegistered && contactPhone)}
									onClick={() => makeCall(contactPhone)}
									className="h-14 rounded-2xl bg-slate-900 hover:bg-slate-800! border-none font-bold flex items-center justify-center gap-3 transition-all"
								>
									Qo'ng'iroq qilish
								</Button>
							</Tooltip>
							<Button
								block
								size="large"
								icon={<UserOutlined />}
								onClick={() => navigate(`/contacts/${ticket.contactId}`)}
								className="h-14 rounded-2xl border-slate-200 hover:border-slate-900 hover:text-slate-900 text-slate-600 font-bold flex items-center justify-center gap-3"
							>
								To'liq profilni ko'rish
							</Button>
						</div>
					</Card>
				</div>
			</div>
		</div>
	);
}
