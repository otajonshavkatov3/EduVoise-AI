import {
	CalendarOutlined,
	EditOutlined,
	RobotOutlined,
	UserOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import { Button, Card, Dropdown, Empty, Skeleton, Space, Tag, Tooltip, Typography } from "antd";
import type { FollowUpStatus, FollowUpTask } from "../types";
import { FOLLOW_UP_STATUS_CONFIG, FOLLOW_UP_STATUS_ORDER } from "./FollowUpStatusTag";

const { Text } = Typography;

interface Props {
	tasks: FollowUpTask[];
	isLoading: boolean;
	onEdit: (task: FollowUpTask) => void;
	onStatusChange: (task: FollowUpTask, status: FollowUpStatus) => void;
}

function formatDue(dueAt: string | null): string {
	if (!dueAt) {
		return "Muddat belgilanmagan";
	}
	const date = new Date(dueAt);
	return `${date.toLocaleDateString("uz-UZ")} ${date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	})}`;
}

interface TaskCardProps {
	task: FollowUpTask;
	onEdit: (task: FollowUpTask) => void;
	onStatusChange: (task: FollowUpTask, status: FollowUpStatus) => void;
}

function TaskCard({ task, onEdit, onStatusChange }: TaskCardProps) {
	return (
		<div
			className={`rounded-xl border border-slate-100 p-4 transition-all hover:shadow-sm ${
				task.isOverdue ? "border-l-4 border-l-rose-500 bg-rose-50/60" : "bg-slate-50 hover:bg-white"
			}`}
		>
			<div className="mb-2 flex items-start justify-between gap-2">
				<Text className="font-bold leading-tight text-slate-900">{task.title}</Text>
				<Space size={4}>
					{task.createdBySystem && (
						<Tooltip title="AI yaratgan vazifa">
							<RobotOutlined className="text-purple-500" />
						</Tooltip>
					)}
					<Dropdown
						trigger={["click"]}
						menu={{
							items: FOLLOW_UP_STATUS_ORDER.filter((status) => status !== task.status).map(
								(status) => ({
									key: status,
									label: FOLLOW_UP_STATUS_CONFIG[status].label,
									icon: FOLLOW_UP_STATUS_CONFIG[status].icon,
								})
							),
							onClick: ({ key }) => onStatusChange(task, key as FollowUpStatus),
						}}
					>
						<Button
							type="text"
							size="small"
							icon={<EditOutlined />}
							className="text-slate-400 hover:text-blue-600!"
						/>
					</Dropdown>
				</Space>
			</div>

			{task.description && (
				<Text className="mb-3 block text-xs font-medium text-slate-500">
					{task.description.length > 120
						? `${task.description.slice(0, 120)}...`
						: task.description}
				</Text>
			)}

			<div className="flex flex-wrap items-center gap-3">
				<Space size={4}>
					<CalendarOutlined
						className={task.isOverdue ? "text-rose-500" : "text-slate-300"}
						aria-hidden
					/>
					<Text
						className={`text-[11px] font-bold ${
							task.isOverdue ? "text-rose-500" : "text-slate-500"
						}`}
					>
						{formatDue(task.dueAt)}
					</Text>
				</Space>

				{task.isOverdue && (
					<Tag
						color="red"
						icon={<WarningOutlined />}
						className="m-0 rounded-lg border-none px-2 text-[10px] font-bold uppercase"
					>
						Muddati o'tgan
					</Tag>
				)}

				{task.assignee && (
					<Space size={4}>
						<UserOutlined className="text-slate-300" />
						<Text className="text-[11px] font-bold text-slate-500">{task.assignee.extension}</Text>
					</Space>
				)}
			</div>

			<Button
				type="link"
				size="small"
				onClick={() => onEdit(task)}
				className="mt-2 px-0 text-[11px] font-black uppercase tracking-wider"
			>
				Tahrirlash
			</Button>
		</div>
	);
}

/** Holat bo'yicha guruhlangan kanban ko'rinish */
export function FollowUpBoard({ tasks, isLoading, onEdit, onStatusChange }: Props) {
	if (isLoading) {
		return (
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
				{FOLLOW_UP_STATUS_ORDER.map((status) => (
					<Card key={status} className="rounded-2xl shadow-sm">
						<Skeleton active paragraph={{ rows: 4 }} />
					</Card>
				))}
			</div>
		);
	}

	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
			{FOLLOW_UP_STATUS_ORDER.map((status) => {
				const config = FOLLOW_UP_STATUS_CONFIG[status];
				const columnTasks = tasks.filter((task) => task.status === status);
				return (
					<Card
						key={status}
						className="h-full rounded-2xl shadow-sm"
						title={
							<Space size={8}>
								<span className={config.columnClass}>{config.icon}</span>
								<span className="text-[11px] font-black uppercase tracking-widest">
									{config.label}
								</span>
							</Space>
						}
						extra={<Text className="text-xs font-bold text-slate-500">{columnTasks.length}</Text>}
					>
						{columnTasks.length === 0 ? (
							<Empty
								className="py-6"
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={<span className="text-[11px] text-slate-400">Vazifa yo'q</span>}
							/>
						) : (
							<div className="flex flex-col gap-3">
								{columnTasks.map((task) => (
									<TaskCard
										key={task.id}
										task={task}
										onEdit={onEdit}
										onStatusChange={onStatusChange}
									/>
								))}
							</div>
						)}
					</Card>
				);
			})}
		</div>
	);
}
