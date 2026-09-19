import {
	AppstoreOutlined,
	CalendarOutlined,
	PlusOutlined,
	RobotOutlined,
	TableOutlined,
	UserOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import {
	Alert,
	Button,
	Card,
	Dropdown,
	Empty,
	Popconfirm,
	Segmented,
	Space,
	Table,
	Tooltip,
	Typography,
} from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { FollowUpBoard } from "../components/FollowUpBoard";
import { FollowUpFilters } from "../components/FollowUpFilters";
import { FollowUpFormModal } from "../components/FollowUpFormModal";
import {
	FOLLOW_UP_STATUS_CONFIG,
	FOLLOW_UP_STATUS_ORDER,
	FollowUpStatusTag,
} from "../components/FollowUpStatusTag";
import { useCancelFollowUp, useFollowUps, useUpdateFollowUp } from "../hooks/useFollowUps";
import type { FollowUpStatus, FollowUpTask, FollowUpFilters as IFollowUpFilters } from "../types";

const { Text } = Typography;

type ViewMode = "table" | "board";

const INITIAL_FILTERS: IFollowUpFilters = { page: 1, limit: 20, overdue: "false" };
/** Kanban ko'rinishida barcha ustunlar to'lishi uchun kattaroq sahifa */
const BOARD_LIMIT = 100;

export default function FollowUpsPage() {
	const navigate = useNavigate();
	const [view, setView] = useState<ViewMode>("table");
	const [filters, setFilters] = useState<IFollowUpFilters>(INITIAL_FILTERS);
	const [editingTask, setEditingTask] = useState<FollowUpTask | null>(null);
	const [isFormOpen, setIsFormOpen] = useState(false);

	const effectiveFilters: IFollowUpFilters =
		view === "board" ? { ...filters, status: undefined, page: 1, limit: BOARD_LIMIT } : filters;

	const { data, isLoading, isFetching, isError, error, refetch } = useFollowUps(effectiveFilters);
	const updateTask = useUpdateFollowUp();
	const cancelTask = useCancelFollowUp();

	const tasks = data?.data.items ?? [];
	const meta = data?.data.meta;

	const openCreate = () => {
		setEditingTask(null);
		setIsFormOpen(true);
	};

	const openEdit = (task: FollowUpTask) => {
		setEditingTask(task);
		setIsFormOpen(true);
	};

	const handleStatusChange = (task: FollowUpTask, status: FollowUpStatus) => {
		updateTask.mutate({ id: task.id, data: { status } });
	};

	const columns = [
		{
			title: "Vazifa",
			key: "title",
			render: (_: unknown, record: FollowUpTask) => (
				<div className="flex flex-col">
					<Space size={6}>
						<span className="font-bold text-slate-900">{record.title}</span>
						{record.createdBySystem && (
							<Tooltip title="AI yaratgan vazifa">
								<RobotOutlined className="text-purple-500" />
							</Tooltip>
						)}
					</Space>
					{record.description && (
						<Text className="text-[11px] font-medium text-slate-500">
							{record.description.length > 90
								? `${record.description.slice(0, 90)}...`
								: record.description}
						</Text>
					)}
				</div>
			),
		},
		{
			title: "Holat",
			key: "status",
			render: (_: unknown, record: FollowUpTask) => <FollowUpStatusTag status={record.status} />,
		},
		{
			title: "Muddat",
			key: "dueAt",
			render: (_: unknown, record: FollowUpTask) => {
				if (!record.dueAt) {
					return <Text className="text-xs italic text-slate-400">Belgilanmagan</Text>;
				}
				const date = new Date(record.dueAt);
				return (
					<Space size={6}>
						<CalendarOutlined className={record.isOverdue ? "text-rose-500" : "text-slate-300"} />
						<div className="flex flex-col">
							<span
								className={`text-xs font-bold ${
									record.isOverdue ? "text-rose-500" : "text-slate-600"
								}`}
							>
								{date.toLocaleDateString("uz-UZ")}
							</span>
							<span className="text-[10px] text-slate-400">
								{date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
							</span>
						</div>
						{record.isOverdue && (
							<Tooltip title="Muddati o'tgan">
								<WarningOutlined className="text-rose-500" />
							</Tooltip>
						)}
					</Space>
				);
			},
		},
		{
			title: "Mas'ul",
			key: "assignee",
			render: (_: unknown, record: FollowUpTask) =>
				record.assignee ? (
					<Space size={6}>
						<UserOutlined className="text-slate-300" />
						<span className="text-xs font-bold text-slate-700">{record.assignee.extension}</span>
					</Space>
				) : (
					<Text className="text-xs italic text-slate-400">Biriktirilmagan</Text>
				),
		},
		{
			title: "Mijoz",
			key: "contact",
			render: (_: unknown, record: FollowUpTask) =>
				record.contact ? (
					<div className="flex flex-col">
						<span className="text-xs font-bold text-slate-700">
							{[record.contact.firstName, record.contact.lastName].filter(Boolean).join(" ") ||
								"Noma'lum"}
						</span>
						<span className="font-mono text-[10px] text-slate-400">
							{record.contact.phoneNumber}
						</span>
					</div>
				) : (
					<Text className="text-xs italic text-slate-400">-</Text>
				),
		},
		{
			title: "Amallar",
			key: "actions",
			render: (_: unknown, record: FollowUpTask) => (
				<Space size="small">
					<Button onClick={() => openEdit(record)} className="rounded-xl font-bold" size="small">
						Tahrirlash
					</Button>
					<Dropdown
						trigger={["click"]}
						menu={{
							items: FOLLOW_UP_STATUS_ORDER.filter((status) => status !== record.status).map(
								(status) => ({
									key: status,
									label: FOLLOW_UP_STATUS_CONFIG[status].label,
									icon: FOLLOW_UP_STATUS_CONFIG[status].icon,
								})
							),
							onClick: ({ key }) => handleStatusChange(record, key as FollowUpStatus),
						}}
					>
						<Button size="small" className="rounded-xl font-bold">
							Holat
						</Button>
					</Dropdown>
					{record.callId && (
						<Tooltip title="Qo'ng'iroqni ko'rish">
							<Button
								size="small"
								type="link"
								onClick={() => navigate(`/calls/${record.callId}`)}
								className="px-0 font-bold"
							>
								Qo'ng'iroq
							</Button>
						</Tooltip>
					)}
					{record.status !== "cancelled" && (
						<Popconfirm
							title="Vazifani bekor qilish?"
							description="Vazifa o'chirilmaydi, holati 'bekor qilingan' bo'ladi."
							okText="Ha"
							cancelText="Yo'q"
							onConfirm={() => cancelTask.mutate(record.id)}
						>
							<Button size="small" danger className="rounded-xl font-bold">
								Bekor
							</Button>
						</Popconfirm>
					)}
				</Space>
			),
		},
	];

	return (
		<div className="animate-fadeIn">
			<div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-center">
				<div>
					<h1 className="text-3xl font-black tracking-tight text-slate-900">
						Keyingi aloqa vazifalari
					</h1>
					<p className="font-medium text-slate-500">
						Qo'ng'iroqdan keyingi vazifalar, muddatlar va mas'ul xodimlar
					</p>
				</div>

				<Space size="middle">
					<Segmented<ViewMode>
						size="large"
						value={view}
						onChange={setView}
						options={[
							{ value: "table", icon: <TableOutlined />, label: "Jadval" },
							{ value: "board", icon: <AppstoreOutlined />, label: "Doska" },
						]}
					/>
					<Button
						type="primary"
						icon={<PlusOutlined />}
						size="large"
						onClick={openCreate}
						className="h-12 rounded-xl px-6 font-bold shadow-lg shadow-blue-500/20"
					>
						Yangi vazifa
					</Button>
				</Space>
			</div>

			<FollowUpFilters
				filters={filters}
				onFiltersChange={(next) => setFilters((current) => ({ ...current, ...next }))}
				onReset={() => setFilters(INITIAL_FILTERS)}
				onRefresh={() => refetch()}
				isFetching={isFetching}
				showStatusFilter={view === "table"}
			/>

			{isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Vazifalarni yuklab bo'lmadi"
					description={getApiErrorMessage(error, "Server bilan aloqa yo'q")}
					action={
						<Button size="small" onClick={() => refetch()}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			{view === "board" ? (
				<FollowUpBoard
					tasks={tasks}
					isLoading={isLoading}
					onEdit={openEdit}
					onStatusChange={handleStatusChange}
				/>
			) : (
				<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
					<Table
						columns={columns}
						dataSource={tasks}
						loading={isLoading}
						rowKey="id"
						scroll={{ x: 1100 }}
						rowClassName={(record) => (record.isOverdue ? "bg-rose-50/60" : "")}
						locale={{
							emptyText: (
								<Empty
									className="py-12"
									image={Empty.PRESENTED_IMAGE_SIMPLE}
									description="Vazifalar topilmadi"
								/>
							),
						}}
						pagination={{
							current: meta?.page,
							pageSize: meta?.limit,
							total: meta?.total,
							showSizeChanger: true,
							className: "px-6 pb-4",
							onChange: (page, limit) => setFilters((current) => ({ ...current, page, limit })),
						}}
					/>
				</Card>
			)}

			<FollowUpFormModal
				open={isFormOpen}
				task={editingTask}
				onClose={() => {
					setIsFormOpen(false);
					setEditingTask(null);
				}}
			/>
		</div>
	);
}
