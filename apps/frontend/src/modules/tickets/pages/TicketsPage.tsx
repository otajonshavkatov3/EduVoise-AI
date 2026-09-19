import {
	DeleteOutlined,
	EditOutlined,
	PlusOutlined,
	TagOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Avatar, Button, Card, Popconfirm, Space, Table, Tag, Tooltip, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatDate, formatTime } from "@/shared/utils/datetime";
import { ticketCategoryLabel } from "@/shared/utils/labels";
import { TicketCreateModal } from "../components/TicketCreateModal";
import { TicketEditModal } from "../components/TicketEditModal";
import { TicketFilters } from "../components/TicketFilters";
import { TicketPriorityTag } from "../components/TicketPriorityTag";
import { TicketStatusBadge } from "../components/TicketStatusBadge";
import { useRemoveTicket, useTickets } from "../hooks/useTickets";
import type { TicketItem, TicketPriority, TicketStatus } from "../types";

const { Text } = Typography;

export default function TicketsPage() {
	const navigate = useNavigate();
	const [filters, setFilters] = useState({
		page: 1,
		limit: 10,
		status: undefined as string | undefined,
		priority: undefined as string | undefined,
		q: undefined as string | undefined,
	});

	const { data: ticketsData, isLoading } = useTickets(filters);
	const removeTicket = useRemoveTicket();

	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [selectedTicket, setSelectedTicket] = useState<TicketItem | null>(null);

	const handleEdit = (ticket: TicketItem) => {
		setSelectedTicket(ticket);
		setIsEditModalOpen(true);
	};

	const handleDelete = async (id: string) => {
		try {
			await removeTicket.mutateAsync(id);
		} catch {
			// Handled by hook
		}
	};

	const columns = [
		{
			title: "Murojaat ma'lumotlari",
			key: "detail",
			width: 300,
			render: (_: unknown, record: TicketItem) => (
				<div className="flex flex-col gap-1">
					<Text className="font-bold text-slate-900 truncate block">{record.subject}</Text>
					<Text type="secondary" className="text-[11px] font-mono opacity-60">
						#{record.id.slice(0, 8).toUpperCase()}
					</Text>
					{record.category && (
						<div className="mt-1">
							<Tag
								icon={<TagOutlined className="text-[10px]" />}
								className="text-[10px] bg-slate-50 border-slate-200 text-slate-500 rounded-md py-0"
							>
								{ticketCategoryLabel(record.category)}
							</Tag>
						</div>
					)}
				</div>
			),
		},
		{
			title: "Kontakt",
			key: "contact",
			render: (_: unknown, record: TicketItem) => (
				<div className="flex flex-col">
					<Text className="font-bold text-slate-700 text-xs">
						{record.contact?.firstName || "Noma'lum kontakt"}
					</Text>
					<Text type="secondary" className="text-[11px]">
						{record.contact?.phoneNumber}
					</Text>
				</div>
			),
		},
		{
			title: "Muhimlik",
			dataIndex: "priority",
			key: "priority",
			render: (priority: TicketPriority) => <TicketPriorityTag priority={priority} />,
		},
		{
			title: "Holat",
			dataIndex: "status",
			key: "status",
			render: (status: TicketStatus) => <TicketStatusBadge status={status} />,
		},
		{
			title: "Yaratuvchi",
			key: "creator",
			render: (_: unknown, record: TicketItem) => (
				<div className="flex items-center gap-2">
					<Avatar
						size="small"
						icon={<UserOutlined />}
						className="bg-slate-100 text-slate-400 border border-slate-200"
					/>
					<span className="text-xs text-slate-500">{record.creator?.phone || "Tizim"}</span>
				</div>
			),
		},
		{
			title: "Yaratilgan vaqt",
			dataIndex: "createdAt",
			key: "createdAt",
			align: "right" as const,
			render: (date: string) => (
				<div className="flex flex-col text-right">
					<span className="text-xs font-bold text-slate-600">{formatDate(date)}</span>
					<span className="text-[10px] text-slate-400">{formatTime(date)}</span>
				</div>
			),
		},
		{
			title: "Amallar",
			key: "actions",
			align: "right" as const,
			render: (_: unknown, record: TicketItem) => (
				<Space onClick={(e) => e.stopPropagation()}>
					<Tooltip title="Murojaatni tahrirlash">
						<Button
							type="text"
							icon={<EditOutlined className="text-blue-600" />}
							onClick={(e) => {
								e.stopPropagation();
								handleEdit(record);
							}}
							className="hover:bg-blue-50 transition-colors"
						/>
					</Tooltip>
					<Tooltip title="Murojaatni o'chirish">
						<Popconfirm
							title="Murojaatni o'chirish"
							description="Haqiqatan ham ushbu murojaatni o'chirib tashlamoqchimisiz?"
							onConfirm={() => handleDelete(record.id)}
							okText="Ha"
							cancelText="Yo'q"
							okButtonProps={{ danger: true, loading: removeTicket.isPending }}
						>
							<Button
								type="text"
								icon={<DeleteOutlined className="text-rose-500" />}
								onClick={(e) => e.stopPropagation()}
								className="hover:bg-rose-50 transition-colors"
							/>
						</Popconfirm>
					</Tooltip>
				</Space>
			),
		},
	];

	return (
		<div className="animate-fadeIn">
			{/* Page Header */}
			<div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
				<div>
					<h1 className="text-3xl font-black text-slate-900 tracking-tight">Murojaatlar</h1>
					<p className="text-slate-500 font-medium">
						Mijozlar so'rovlarini boshqarish, kuzatish va hal qilish
					</p>
				</div>
				<Button
					type="primary"
					icon={<PlusOutlined />}
					size="large"
					onClick={() => setIsCreateModalOpen(true)}
					className="h-12 px-6 font-bold shadow-lg shadow-blue-500/20 rounded-xl"
				>
					Yangi murojaat
				</Button>
			</div>

			<TicketFilters
				onFilterChange={(newFilters) => setFilters((f) => ({ ...f, ...newFilters, page: 1 }))}
			/>

			{/* main Table */}
			<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
				<Table
					columns={columns}
					dataSource={ticketsData?.data.items || []}
					loading={isLoading}
					rowKey="id"
					pagination={{
						current: ticketsData?.data.meta.page,
						pageSize: ticketsData?.data.meta.limit,
						total: ticketsData?.data.meta.total,
						onChange: (page, limit) => setFilters((f) => ({ ...f, page, limit })),
						showSizeChanger: true,
						className: "px-6 pb-4",
					}}
					onRow={(record) => ({
						onClick: () => navigate(`/tickets/${record.id}`),
						className: "cursor-pointer transition-all hover:bg-slate-50/50",
					})}
				/>
			</Card>

			<TicketCreateModal open={isCreateModalOpen} onCancel={() => setIsCreateModalOpen(false)} />

			<TicketEditModal
				open={isEditModalOpen}
				ticket={selectedTicket}
				onCancel={() => {
					setIsEditModalOpen(false);
					setSelectedTicket(null);
				}}
			/>
		</div>
	);
}
