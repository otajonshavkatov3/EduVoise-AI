import {
	DeleteOutlined,
	EditOutlined,
	InfoCircleOutlined,
	PhoneOutlined,
	PlusOutlined,
	UserOutlined,
} from "@ant-design/icons";
import {
	Alert,
	Avatar,
	Badge,
	Button,
	Card,
	Empty,
	Popconfirm,
	Space,
	Table,
	Tag,
	Tooltip,
} from "antd";
import { useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { formatDate } from "@/shared/utils/datetime";
import { OperatorCreateModal } from "../components/OperatorCreateModal";
import { OperatorEditModal } from "../components/OperatorEditModal";
import { OperatorFilters } from "../components/OperatorFilters";
import { OperatorStatusTag } from "../components/OperatorStatusTag";
import { useOperators, useRemoveOperator } from "../hooks/useOperators";
import type { OperatorProfile, OperatorStatus } from "../types";

export default function OperatorsPage() {
	const [filters, setFilters] = useState({
		page: 1,
		limit: 10,
		includeDeleted: false,
	});
	// Holat bo'yicha filtr serverda yo'q — faqat joriy sahifa ichida qo'llanadi.
	const [statusFilter, setStatusFilter] = useState<OperatorStatus | undefined>(undefined);
	const { data: operatorsData, isLoading, isError, error, refetch } = useOperators(filters);
	const removeOperator = useRemoveOperator();

	const pageItems = operatorsData?.data.items ?? [];
	const visibleItems = statusFilter
		? pageItems.filter((item) => item.currentStatus === statusFilter)
		: pageItems;
	const hiddenByStatus = pageItems.length - visibleItems.length;

	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [selectedOperator, setSelectedOperator] = useState<OperatorProfile | null>(null);

	const handleEdit = (operator: OperatorProfile) => {
		setSelectedOperator(operator);
		setIsEditModalOpen(true);
	};

	const handleDelete = async (id: string) => {
		try {
			await removeOperator.mutateAsync(id);
		} catch {
			// Handled by hook
		}
	};

	const columns = [
		{
			title: "Operator",
			key: "operator",
			render: (_: unknown, record: OperatorProfile) => (
				<Space size="middle">
					<Badge
						dot
						status={record.currentStatus === "online" ? "success" : "default"}
						offset={[-4, 32]}
					>
						<Avatar icon={<UserOutlined />} className="bg-slate-100 text-slate-400" size={42} />
					</Badge>
					<div className="flex flex-col">
						<span className="font-bold text-slate-900 leading-none mb-1">
							{record.user?.phone || "Noma'lum foydalanuvchi"}
						</span>
						<span className="text-xs text-slate-400 flex items-center gap-1">
							<PhoneOutlined className="text-[10px]" /> Ext: {record.extension}
						</span>
					</div>
				</Space>
			),
		},
		{
			title: "Ichki raqam",
			dataIndex: "extension",
			key: "extension",
			render: (ext: string) => (
				<code className="bg-slate-50 px-2.5 py-1 rounded text-blue-600 font-mono font-bold border border-slate-100">
					{ext}
				</code>
			),
		},
		{
			title: "Holat",
			dataIndex: "currentStatus",
			key: "currentStatus",
			render: (status: OperatorStatus) => <OperatorStatusTag status={status} />,
		},
		{
			title: "Roli",
			key: "role",
			render: (_: unknown, record: OperatorProfile) => (
				<Tag
					color="geekblue"
					className="capitalize font-bold px-3 py-0.5 rounded-full border-none shadow-sm opacity-80"
				>
					{record.user?.role || "Operator"}
				</Tag>
			),
		},
		{
			title: "Yaratilgan vaqt",
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
			render: (_: unknown, record: OperatorProfile) => (
				<Space>
					<Tooltip title="Operator profilini tahrirlash">
						<Button
							type="text"
							icon={<EditOutlined className="text-blue-600" />}
							onClick={() => handleEdit(record)}
							className="hover:bg-blue-50 transition-colors"
						/>
					</Tooltip>
					<Tooltip title="Profilni o'chirish">
						<Popconfirm
							title="Operator profilini o'chirish"
							description="Haqiqatan ham ushbu operator profilini o'chirib tashlamoqchimisiz?"
							onConfirm={() => handleDelete(record.id)}
							okText="Ha"
							cancelText="Yo'q"
							okButtonProps={{ danger: true, loading: removeOperator.isPending }}
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
						Operatorlarni boshqarish
					</h1>
					<p className="text-slate-500 font-medium">
						Ichki yo'nalishlarni sozlash va holatni kuzatish
					</p>
				</div>
				<Button
					type="primary"
					icon={<PlusOutlined />}
					size="large"
					onClick={() => setIsCreateModalOpen(true)}
					className="h-12 px-6 font-bold shadow-lg shadow-blue-500/20 rounded-xl"
				>
					Operator qo'shish
				</Button>
			</div>

			<OperatorFilters
				onFilterChange={(next) => {
					if ("status" in next) {
						setStatusFilter(next.status);
					}
					if ("includeDeleted" in next) {
						setFilters((f) => ({
							...f,
							includeDeleted: next.includeDeleted ?? false,
							page: 1,
						}));
					}
				}}
			/>

			{isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Operatorlarni yuklab bo'lmadi"
					description={getApiErrorMessage(error, "Server bilan aloqa yo'q")}
					action={
						<Button size="small" onClick={() => refetch()}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			{!isError && hiddenByStatus > 0 && (
				<Alert
					type="info"
					showIcon
					icon={<InfoCircleOutlined />}
					className="mb-6 rounded-2xl"
					message={`Holat filtri joriy sahifadagi ${hiddenByStatus} yozuvni yashirdi. Filtr serverda emas, shu sahifada qo'llanadi.`}
				/>
			)}

			{/* main Table */}
			<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
				<Table
					columns={columns}
					dataSource={visibleItems}
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
										: statusFilter
											? "Bu holatdagi operator shu sahifada yo'q"
											: "Operatorlar topilmadi"
								}
							/>
						),
					}}
					pagination={{
						current: operatorsData?.data.meta.page,
						pageSize: operatorsData?.data.meta.limit,
						total: operatorsData?.data.meta.total,
						onChange: (page, limit) => setFilters((f) => ({ ...f, page, limit })),
						showSizeChanger: true,
						className: "px-6 pb-4",
					}}
					onRow={(record) => ({
						onClick: () => handleEdit(record),
						className: "cursor-pointer transition-colors",
					})}
				/>
			</Card>

			<OperatorCreateModal open={isCreateModalOpen} onCancel={() => setIsCreateModalOpen(false)} />

			<OperatorEditModal
				open={isEditModalOpen}
				operator={selectedOperator}
				onCancel={() => {
					setIsEditModalOpen(false);
					setSelectedOperator(null);
				}}
			/>
		</div>
	);
}
