import { EyeOutlined, HistoryOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Avatar, Button, Card, Empty, Space, Table, Tag } from "antd";
import { useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { formatDate, formatTime } from "@/shared/utils/datetime";
import { AuditDetailModal } from "../components/AuditDetailModal";
import { AuditFilters } from "../components/AuditFilters";
import { useAuditLogs } from "../hooks/useAuditLogs";
import type { AuditLog, AuditFilters as IAuditFilters } from "../types";
import { auditActionLabel, auditEntityLabel } from "../utils/labels";

export default function AuditLogsPage() {
	const [filters, setFilters] = useState<IAuditFilters>({ page: 1, limit: 10 });
	const { data: auditData, isLoading, isError, error, refetch } = useAuditLogs(filters);
	const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
	const [isModalOpen, setIsModalOpen] = useState(false);

	const handleViewDetails = (log: AuditLog) => {
		setSelectedLog(log);
		setIsModalOpen(true);
	};

	const columns = [
		{
			title: "Harakat",
			key: "action",
			render: (_: unknown, record: AuditLog) => (
				<Space size="middle">
					<Avatar
						icon={<HistoryOutlined />}
						className="bg-indigo-50 text-indigo-600 border border-indigo-100"
						size={36}
					/>
					<div className="flex flex-col">
						<span className="font-bold text-slate-900 leading-none mb-1">
							{auditActionLabel(record.action)}
						</span>
						{/* Obyekt turi yo'q bo'lsa yorliq umuman chizilmaydi — avval
						    "general" degan, ma'lumotlarda mavjud bo'lmagan tur yozilardi. */}
						{record.entityType && (
							<Tag
								color="blue"
								className="text-[10px] font-bold uppercase tracking-wider border-none rounded-md px-1.5 leading-none h-4"
							>
								{auditEntityLabel(record.entityType)}
							</Tag>
						)}
					</div>
				</Space>
			),
		},
		{
			title: "Bajaruvchi",
			key: "userName",
			render: (_: unknown, record: AuditLog) => (
				<Space>
					<Avatar size="small" icon={<UserOutlined />} className="bg-slate-100 text-slate-400" />
					<div className="flex flex-col">
						{record.userName ?? <span className="text-xs italic text-slate-400">Aniqlanmagan</span>}
					</div>
				</Space>
			),
		},
		{
			title: "IP manzili",
			dataIndex: "ipAddress",
			key: "ipAddress",
			// IP yozilmagan bo'lsa uni "Local" deb ko'rsatish soxta xulosa edi.
			render: (ip: string | null) =>
				ip ? (
					<span className="text-xs font-mono text-slate-500">{ip}</span>
				) : (
					<span className="text-xs italic text-slate-400">Yozilmagan</span>
				),
		},
		{
			title: "Vaqt",
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
			render: (_: unknown, record: AuditLog) => (
				<button
					type="button"
					onClick={() => handleViewDetails(record)}
					className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-400 hover:text-indigo-600"
				>
					<EyeOutlined />
				</button>
			),
		},
	];

	return (
		<div className="animate-fadeIn">
			{/* Page Header */}
			<div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
				<div>
					<h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
						Audit jurnallari
					</h1>
					<p className="text-slate-500 font-medium">
						Tizim faoliyati va xavfsizlik hodisalarini kuzatish
					</p>
				</div>
			</div>

			<AuditFilters
				onFiltersChange={(newFilters) => setFilters((f) => ({ ...f, ...newFilters }))}
			/>

			{isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Audit jurnallarini yuklab bo'lmadi"
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

			<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
				<Table
					columns={columns}
					dataSource={auditData?.data.items || []}
					loading={isLoading}
					rowKey="id"
					locale={{
						emptyText: (
							<Empty
								className="py-12"
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={isError ? "Ma'lumot yuklanmadi" : "Audit yozuvlari topilmadi"}
							/>
						),
					}}
					pagination={{
						current: auditData?.data.meta.page,
						pageSize: auditData?.data.meta.limit,
						total: auditData?.data.meta.total,
						onChange: (page, limit) => setFilters((f) => ({ ...f, page, limit })),
						showSizeChanger: true,
						className: "px-6 pb-4",
					}}
					onRow={(record) => ({
						onDoubleClick: () => handleViewDetails(record),
						className: "cursor-pointer group",
					})}
				/>
			</Card>

			<AuditDetailModal
				log={selectedLog}
				open={isModalOpen}
				onCancel={() => {
					setIsModalOpen(false);
					setSelectedLog(null);
				}}
			/>
		</div>
	);
}
