import { ExclamationCircleOutlined, PhoneOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Avatar, Button, Card, Empty, Space, Table, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { EMPTY_VALUE, formatDate, formatTime } from "@/shared/utils/datetime";
import { CallDirectionTag } from "../components/CallDirectionTag";
import { CallFilters } from "../components/CallFilters";
import { CallStatusBadge } from "../components/CallStatusBadge";
import { useMissedCalls } from "../hooks/useCalls";
import { callService } from "../services/call.service";
import type { Call, CallFilters as ICallFilters } from "../types";

const { Text } = Typography;

const INITIAL_FILTERS: ICallFilters = { page: 1, limit: 10, status: "missed" };

export default function MissedCallsPage() {
	const [filters, setFilters] = useState<ICallFilters>(INITIAL_FILTERS);
	const {
		data: callsData,
		isLoading,
		isFetching,
		isError,
		error,
		refetch,
	} = useMissedCalls(filters);
	const navigate = useNavigate();
	const [isExporting, setIsExporting] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);

	const handleExport = async () => {
		setExportError(null);
		try {
			setIsExporting(true);
			const blob = await callService.export(filters);
			const url = window.URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `missed_calls_export_${new Date().toISOString()}.csv`;
			document.body.appendChild(a);
			a.click();
			window.URL.revokeObjectURL(url);
			document.body.removeChild(a);
		} catch (err) {
			setExportError(getApiErrorMessage(err, "Faylni yuklab bo'lmadi"));
		} finally {
			setIsExporting(false);
		}
	};

	const columns = [
		{
			title: "Qo'ng'iroq qiluvchi",
			key: "info",
			render: (_: unknown, record: Call) => (
				<Space size="middle">
					<Avatar
						icon={<PhoneOutlined />}
						className="bg-rose-50 text-rose-600 border border-rose-100"
						size={40}
					/>
					<div className="flex flex-col">
						<span className="font-bold text-slate-900 leading-none mb-1">
							{record.contactName || record.callerNumber}
						</span>
						<div className="flex items-center gap-2 text-[10px] text-slate-400">
							<CallDirectionTag direction={record.direction} />
							<CallStatusBadge status={record.status} />
						</div>
					</div>
				</Space>
			),
		},
		{
			title: "Kontakt",
			key: "contact",
			render: (_: unknown, record: Call) => {
				if (!record.contactName) {
					return (
						<Text type="secondary" className="italic text-xs">
							Noma'lum mehmon
						</Text>
					);
				}
				return (
					<Space>
						<Avatar size="small" icon={<UserOutlined />} className="bg-slate-100 text-slate-400" />
						<span className="text-xs font-medium text-slate-700">{record.contactName}</span>
					</Space>
				);
			},
		},
		{
			title: "Kutish vaqti",
			dataIndex: "duration",
			key: "duration",
			render: (duration: number | null) => (
				<span className="text-xs font-mono font-bold text-rose-500">
					{duration ? `${duration} soniya` : EMPTY_VALUE}
				</span>
			),
		},
		{
			title: "Urinish vaqti",
			dataIndex: "startedAt",
			key: "startedAt",
			render: (date: string) => (
				<div className="flex flex-col">
					<span className="text-xs font-medium text-slate-600">{formatDate(date)}</span>
					<span className="text-[10px] text-slate-400">{formatTime(date)}</span>
				</div>
			),
		},
	];

	return (
		<div className="animate-fadeIn">
			{/* Page Header */}
			<div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
				<div>
					<h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
						<ExclamationCircleOutlined className="text-rose-600" /> Javobsiz qo'ng'iroqlar
					</h1>
					<p className="text-slate-500 font-medium">
						Qayta aloqaga chiqish kerak bo'lgan javobsiz murojaatlar
					</p>
				</div>
			</div>

			{/* Holat tanlovi yo'q: server bu ro'yxatni har doim "missed" ga cheklaydi. */}
			<CallFilters
				filters={filters}
				onFiltersChange={(newFilters) => setFilters((f) => ({ ...f, ...newFilters }))}
				onReset={() => setFilters(INITIAL_FILTERS)}
				onRefresh={() => refetch()}
				onExport={handleExport}
				isExporting={isExporting}
				isFetching={isFetching}
				showStatus={false}
			/>

			{isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Javobsiz qo'ng'iroqlarni yuklab bo'lmadi"
					description={getApiErrorMessage(error, "Server bilan aloqa yo'q")}
					action={
						<Button size="small" onClick={() => refetch()}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			{exportError && (
				<Alert
					type="warning"
					showIcon
					closable
					onClose={() => setExportError(null)}
					className="mb-6 rounded-2xl"
					message="CSV eksport bajarilmadi"
					description={exportError}
				/>
			)}

			{/* main Table */}
			<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
				<Table
					columns={columns}
					dataSource={callsData?.data.items || []}
					loading={isLoading}
					rowKey="id"
					locale={{
						emptyText: (
							<Empty
								className="py-12"
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={isError ? "Ma'lumot yuklanmadi" : "Javobsiz qo'ng'iroqlar mavjud emas"}
							/>
						),
					}}
					pagination={{
						current: callsData?.data.meta.page,
						pageSize: callsData?.data.meta.limit,
						total: callsData?.data.meta.total,
						onChange: (page, limit) => setFilters((f) => ({ ...f, page, limit })),
						showSizeChanger: true,
						className: "px-6 pb-4",
					}}
					// The merged call card, not the old modal: one call must not have two
					// different detail views depending on which list you opened it from.
					onRow={(record) => ({
						onClick: () => navigate(`/calls/${record.id}`),
						className: "cursor-pointer transition-colors",
					})}
				/>
			</Card>
		</div>
	);
}
