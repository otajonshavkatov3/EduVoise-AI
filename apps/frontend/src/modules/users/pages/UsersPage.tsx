import { DeleteOutlined, EditOutlined, PlusOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Avatar, Button, Card, Empty, Popconfirm, Space, Table, Tooltip } from "antd";
import { useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { formatDate } from "@/shared/utils/datetime";
import { UserCreateModal } from "../components/UserCreateModal";
import { UserEditModal } from "../components/UserEditModal";
import { UserFilters } from "../components/UserFilters";
import { UserRoleTag } from "../components/UserRoleTag";
import { UserStatusTag } from "../components/UserStatusTag";
import { useDeleteUser, useUsers } from "../hooks/useUsers";
import type { User, UserRole } from "../types";

export default function UsersPage() {
	const [filters, setFilters] = useState({
		page: 1,
		limit: 10,
		role: undefined as UserRole | undefined,
	});
	const { data: usersData, isLoading, isError, error, refetch } = useUsers(filters);
	const deleteUser = useDeleteUser();

	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [selectedUser, setSelectedUser] = useState<User | null>(null);

	const handleEdit = (user: User) => {
		setSelectedUser(user);
		setIsEditModalOpen(true);
	};

	const handleDelete = async (id: string) => {
		try {
			await deleteUser.mutateAsync(id);
		} catch {
			// Xabar mutation hookida ko'rsatiladi
		}
	};

	const columns = [
		{
			title: "Foydalanuvchi",
			key: "user",
			render: (_: unknown, record: User) => (
				<Space size="middle">
					<Avatar
						icon={<UserOutlined />}
						className={record.isActive ? "bg-blue-600" : "bg-gray-300"}
					/>
					<div className="flex flex-col">
						<span className="font-bold text-slate-900 leading-none mb-1">
							{record.username || ""}
						</span>
						<span className="text-xs text-slate-400">{record.phone}</span>
					</div>
				</Space>
			),
		},
		{
			title: "Elektron pochta",
			dataIndex: "email",
			key: "email",
			render: (email: string | null) =>
				email || <span className="text-slate-300 italic text-xs">Ko'rsatilmagan</span>,
		},
		{
			title: "Roli",
			dataIndex: "role",
			key: "role",
			render: (role: UserRole) => <UserRoleTag role={role} />,
		},
		{
			title: "Holati",
			dataIndex: "isActive",
			key: "isActive",
			render: (isActive: boolean) => <UserStatusTag isActive={isActive} />,
		},
		{
			title: "Qo'shilgan sana",
			dataIndex: "createdAt",
			key: "createdAt",
			render: (date: string) => (
				<span className="text-xs font-medium text-slate-500">{formatDate(date)}</span>
			),
		},
		{
			title: "Amallar",
			key: "actions",
			align: "right" as const,
			render: (_: unknown, record: User) => (
				<Space>
					<Tooltip title="Foydalanuvchini tahrirlash">
						<Button
							type="text"
							icon={<EditOutlined className="text-blue-600" />}
							onClick={() => handleEdit(record)}
							className="hover:bg-blue-50 transition-colors"
						/>
					</Tooltip>
					<Tooltip title="Foydalanuvchini o'chirish">
						<Popconfirm
							title="Foydalanuvchini o'chirish"
							description="Haqiqatan ham ushbu foydalanuvchini o'chirib tashlamoqchimisiz?"
							onConfirm={() => handleDelete(record.id)}
							okText="Ha"
							cancelText="Yo'q"
							okButtonProps={{ danger: true, loading: deleteUser.isPending }}
						>
							<Button
								type="text"
								icon={<DeleteOutlined className="text-rose-500" />}
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
						Tizim foydalanuvchilari
					</h1>
					<p className="text-slate-500 font-medium">
						Tizimga kirish uchun barcha akkauntlarni boshqarish
					</p>
				</div>
				<Button
					type="primary"
					icon={<PlusOutlined />}
					size="large"
					onClick={() => setIsCreateModalOpen(true)}
					className="h-12 px-6 font-bold shadow-lg shadow-blue-500/20 rounded-xl"
				>
					Yangi foydalanuvchi yaratish
				</Button>
			</div>

			<UserFilters
				onFilterChange={(newFilters) => setFilters((f) => ({ ...f, ...newFilters, page: 1 }))}
			/>

			{isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Foydalanuvchilarni yuklab bo'lmadi"
					description={getApiErrorMessage(
						error,
						"Server bilan aloqa yo'q yoki sizda ruxsat yetarli emas"
					)}
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
					dataSource={usersData?.data.items || []}
					loading={isLoading}
					rowKey="id"
					locale={{
						emptyText: (
							<Empty
								className="py-12"
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={isError ? "Ma'lumot yuklanmadi" : "Foydalanuvchilar topilmadi"}
							/>
						),
					}}
					pagination={{
						current: usersData?.data.meta.page,
						pageSize: usersData?.data.meta.limit,
						total: usersData?.data.meta.total,
						onChange: (page, limit) => setFilters((f) => ({ ...f, page, limit })),
						showSizeChanger: true,
						className: "px-6 pb-4",
					}}
					onRow={() => ({
						className: "cursor-pointer transition-colors",
					})}
				/>
			</Card>

			<UserCreateModal open={isCreateModalOpen} onCancel={() => setIsCreateModalOpen(false)} />

			<UserEditModal
				open={isEditModalOpen}
				user={selectedUser}
				onCancel={() => {
					setIsEditModalOpen(false);
					setSelectedUser(null);
				}}
			/>
		</div>
	);
}
