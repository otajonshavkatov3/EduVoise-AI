import {
	CloseCircleOutlined,
	RobotOutlined,
	UserOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Empty, Table, type TableColumnsType, Tag, Tooltip } from "antd";
import { useNavigate } from "react-router-dom";
import { formatPhone } from "@/shared/utils/phoneFormat";
import type { AiSession, AiSessionsResponse } from "../types";
import { contactName, formatDateTime, formatDurationMs, providerLabel } from "../utils/labels";
import { SessionStatusTag } from "./SessionStatusTag";

interface Props {
	data: AiSessionsResponse | undefined;
	isLoading: boolean;
	isError: boolean;
	errorMessage: string | null;
	onPageChange: (page: number, limit: number) => void;
	onRetry: () => void;
}

export function SessionsTable({
	data,
	isLoading,
	isError,
	errorMessage,
	onPageChange,
	onRetry,
}: Props) {
	const navigate = useNavigate();

	const columns: TableColumnsType<AiSession> = [
		{
			title: "Boshlandi",
			dataIndex: "startedAt",
			key: "startedAt",
			render: (value: string) => (
				<span className="text-xs font-semibold text-slate-600">{formatDateTime(value)}</span>
			),
		},
		{
			title: "Mijoz",
			key: "caller",
			render: (_: unknown, record: AiSession) => {
				const name = record.contact
					? contactName(record.contact.firstName, record.contact.lastName)
					: null;
				return (
					<div className="flex flex-col">
						<span className="font-mono text-xs font-bold text-slate-900">
							{formatPhone(record.call.callerNumber)}
						</span>
						<span className="flex items-center gap-1 text-[11px] text-slate-400">
							<UserOutlined />
							{name ?? "Yangi mijoz"}
						</span>
					</div>
				);
			},
		},
		{
			title: "Holat",
			key: "status",
			render: (_: unknown, record: AiSession) => (
				<SessionStatusTag status={record.status} errorMessage={record.errorMessage} />
			),
		},
		{
			title: "Provayder / model",
			key: "provider",
			render: (_: unknown, record: AiSession) => (
				<div className="flex flex-col">
					<span className="text-xs font-bold text-slate-700">{providerLabel(record.provider)}</span>
					<span className="font-mono text-[10px] text-slate-400">{record.model ?? "—"}</span>
				</div>
			),
		},
		{
			title: "Davomiyligi",
			dataIndex: "durationMs",
			key: "durationMs",
			render: (value: number | null) => (
				<span className="font-mono text-xs font-bold text-slate-600">
					{formatDurationMs(value)}
				</span>
			),
		},
		{
			title: "Transkript",
			dataIndex: "transcriptCount",
			key: "transcriptCount",
			render: (value: number) => (
				<Tag className="m-0 rounded-lg border-slate-200 bg-slate-50 text-[11px] font-bold text-slate-500">
					{value} qator
				</Tag>
			),
		},
		{
			title: "Tokenlar",
			key: "tokens",
			render: (_: unknown, record: AiSession) => (
				<span className="font-mono text-[11px] text-slate-500">
					{record.promptTokens ?? 0} / {record.completionTokens ?? 0}
				</span>
			),
		},
		{
			title: "",
			key: "error",
			render: (_: unknown, record: AiSession) =>
				record.errorMessage ? (
					<Tooltip title={record.errorMessage}>
						<WarningOutlined className="text-rose-500" />
					</Tooltip>
				) : null,
		},
	];

	if (isError) {
		return (
			<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
				<Alert
					type="error"
					showIcon
					icon={<CloseCircleOutlined className="text-rose-500" />}
					className="rounded-xl border-rose-200 bg-rose-50"
					message={<span className="font-bold text-rose-600">Sessiyalarni yuklab bo'lmadi</span>}
					description={
						<span className="text-slate-600">{errorMessage ?? "Server javob bermadi."}</span>
					}
					action={
						<Button size="small" onClick={onRetry} className="rounded-lg font-bold">
							Qayta urinish
						</Button>
					}
				/>
			</Card>
		);
	}

	return (
		<Card className="border-none shadow-sm rounded-2xl overflow-hidden">
			<Table<AiSession>
				columns={columns}
				dataSource={data?.data.items ?? []}
				loading={isLoading}
				rowKey="id"
				scroll={{ x: "max-content" }}
				locale={{
					emptyText: (
						<Empty
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							className="py-10"
							description={
								<div className="text-center">
									<RobotOutlined className="text-2xl text-slate-300" />
									<div className="mt-2 text-sm font-bold text-slate-500">
										AI sessiyalari topilmadi
									</div>
									<div className="mt-1 text-xs text-slate-400">
										AI operator qo'ng'iroq qabul qilgach sessiyalar shu yerda paydo bo'ladi
									</div>
								</div>
							}
						/>
					),
				}}
				pagination={{
					current: data?.data.meta.page,
					pageSize: data?.data.meta.limit,
					total: data?.data.meta.total,
					showSizeChanger: true,
					onChange: onPageChange,
					className: "px-6 pb-4",
				}}
				onRow={(record) => ({
					onClick: () => navigate(`/ai-assistant/sessions/${record.id}`),
					className: "cursor-pointer transition-all hover:bg-slate-50/50",
				})}
			/>
		</Card>
	);
}
