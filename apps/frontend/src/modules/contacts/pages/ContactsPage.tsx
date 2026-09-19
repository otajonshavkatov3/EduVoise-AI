import {
	DeleteOutlined,
	EditOutlined,
	EnvironmentOutlined,
	FileTextOutlined,
	PhoneOutlined,
	PlusOutlined,
	UserOutlined,
} from "@ant-design/icons";
import {
	Alert,
	Avatar,
	Button,
	Card,
	Empty,
	Popconfirm,
	Space,
	Table,
	Tooltip,
	Typography,
} from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { EMPTY_VALUE, formatDate, formatTime } from "@/shared/utils/datetime";
import { ContactCreateModal } from "../components/ContactCreateModal";
import { ContactEditModal } from "../components/ContactEditModal";
import { ContactFilters } from "../components/ContactFilters";
import { useContacts, useRemoveContact } from "../hooks/useContacts";
import type { Contact, ContactFilters as IContactFilters } from "../types";

const { Text } = Typography;

export default function ContactsPage() {
	const navigate = useNavigate();
	const [filters, setFilters] = useState<IContactFilters>({ page: 1, limit: 10 });
	const { data: contactsData, isLoading, isError, error, refetch } = useContacts(filters);
	const removeContact = useRemoveContact();

	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [selectedContact, setSelectedContact] = useState<Contact | null>(null);

	const handleEdit = (contact: Contact) => {
		setSelectedContact(contact);
		setIsEditModalOpen(true);
	};

	const handleDelete = async (id: string) => {
		try {
			await removeContact.mutateAsync(id);
		} catch {
			// Handled by hook
		}
	};

	const columns = [
		{
			title: "Kontakt",
			key: "contact",
			render: (_: unknown, record: Contact) => (
				<Space size="middle">
					<Avatar
						icon={<UserOutlined />}
						className="bg-blue-50 text-blue-600 border border-blue-100"
						size={44}
					/>
					<div className="flex flex-col">
						<span className="font-bold text-slate-900 leading-none mb-1">
							{record.firstName || record.lastName
								? `${record.firstName ?? ""} ${record.lastName ?? ""}`
								: "Nomsiz kontakt"}
						</span>
						<span className="text-xs text-slate-400 font-mono flex items-center gap-1">
							<PhoneOutlined className="text-[10px]" /> {record.phoneNumber}
						</span>
					</div>
				</Space>
			),
		},
		{
			title: "Manzil",
			key: "address",
			render: (_: unknown, record: Contact) => {
				const { address } = record;
				if (!(address && (address.tuman || address.kocha || address.uy))) {
					return (
						<Text type="secondary" className="italic text-xs">
							Manzil ko'rsatilmagan
						</Text>
					);
				}
				return (
					<div className="flex flex-col gap-0.5 max-w-[200px]">
						<div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
							<EnvironmentOutlined className="text-blue-500" />
							<span>{address.tuman || EMPTY_VALUE}</span>
						</div>
						<div className="text-[11px] text-slate-400 pl-4">
							{address.kocha ? `${address.kocha}, ` : ""}
							{address.uy || ""}
						</div>
					</div>
				);
			},
		},
		{
			title: "Eslatmalar",
			dataIndex: "notes",
			key: "notes",
			render: (notes: string | null) => (
				<div className="max-w-[150px] truncate">
					{notes ? (
						<Tooltip title={notes}>
							<span className="text-xs text-slate-500 bg-slate-50 px-2 py-0.5 rounded border border-slate-100 flex items-center gap-1">
								<FileTextOutlined className="text-[10px]" /> {notes}
							</span>
						</Tooltip>
					) : (
						<span className="text-slate-300 italic text-[11px]">Eslatmalar yo'q</span>
					)}
				</div>
			),
		},
		{
			title: "Yaratilgan vaqt",
			dataIndex: "createdAt",
			key: "createdAt",
			render: (date: string) => (
				<div className="flex flex-col">
					<span className="text-xs font-medium text-slate-600">{formatDate(date)}</span>
					<span className="text-[10px] text-slate-400">{formatTime(date)}</span>
				</div>
			),
		},
		{
			title: "Amallar",
			key: "actions",
			align: "right" as const,
			render: (_: unknown, record: Contact) => (
				<Space onClick={(e) => e.stopPropagation()}>
					<Tooltip title="Kontaktni tahrirlash">
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
					<Tooltip title="Kontaktni o'chirish">
						<Popconfirm
							title="Kontaktni o'chirish"
							description="Haqiqatan ham ushbu kontaktni o'chirib tashlamoqchimisiz?"
							onConfirm={() => handleDelete(record.id)}
							okText="Ha"
							cancelText="Yo'q"
							okButtonProps={{ danger: true, loading: removeContact.isPending }}
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
					<h1 className="text-3xl font-black text-slate-900 tracking-tight">
						Kontaktlar ma'lumotnomasi
					</h1>
					<p className="text-slate-500 font-medium">
						Mijozlar bazasi va manzillar kitobini boshqarish
					</p>
				</div>
				<Button
					type="primary"
					icon={<PlusOutlined />}
					size="large"
					onClick={() => setIsCreateModalOpen(true)}
					className="h-12 px-6 font-bold shadow-lg shadow-blue-500/20 rounded-xl"
				>
					Yangi kontakt
				</Button>
			</div>

			<ContactFilters onSearch={(q) => setFilters((f) => ({ ...f, q, page: 1 }))} />

			{isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Kontaktlarni yuklab bo'lmadi"
					description={getApiErrorMessage(error, "Server bilan aloqa yo'q")}
					action={
						<Button size="small" onClick={() => refetch()}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			{/* main Table */}
			<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
				<Table
					columns={columns}
					dataSource={contactsData?.data.items || []}
					loading={isLoading}
					rowKey="id"
					locale={{
						emptyText: (
							<Empty
								className="py-12"
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={
									isError
										? "Ma'lumot yuklanmadi"
										: filters.q
											? "Bu so'rov bo'yicha kontakt topilmadi"
											: "Kontaktlar topilmadi"
								}
							/>
						),
					}}
					pagination={{
						current: contactsData?.data.meta.page,
						pageSize: contactsData?.data.meta.limit,
						total: contactsData?.data.meta.total,
						onChange: (page, limit) => setFilters((f) => ({ ...f, page, limit })),
						showSizeChanger: true,
						className: "px-6 pb-4",
					}}
					onRow={(record) => ({
						onClick: () => navigate(`/contacts/${record.id}`),
						className: "cursor-pointer transition-colors",
					})}
				/>
			</Card>

			<ContactCreateModal open={isCreateModalOpen} onCancel={() => setIsCreateModalOpen(false)} />

			<ContactEditModal
				open={isEditModalOpen}
				contact={selectedContact}
				onCancel={() => {
					setIsEditModalOpen(false);
					setSelectedContact(null);
				}}
			/>
		</div>
	);
}
