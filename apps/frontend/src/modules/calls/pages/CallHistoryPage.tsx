import {
	AudioOutlined,
	ClockCircleOutlined,
	FileTextOutlined,
	PhoneOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Alert, Avatar, Button, Card, Empty, Space, Table, Tooltip, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatUsd } from "@/modules/ai-costs/utils/format";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { EMPTY_VALUE, formatDate, formatTime } from "@/shared/utils/datetime";
import { formatPhone } from "@/shared/utils/phoneFormat";
import { AiStatusTag } from "../components/AiStatusTag";
import { AiSentimentTag } from "../components/analysis/AiSentimentTag";
import { CallDirectionTag } from "../components/CallDirectionTag";
import { CallFilters } from "../components/CallFilters";
import { CallStatusBadge } from "../components/CallStatusBadge";
import { useCalls } from "../hooks/useCalls";
import { ActiveCallsSection } from "../live/components/ActiveCallsSection";
import { callService } from "../services/call.service";
import type { CallListItem, CallFilters as ICallFilters } from "../types";

const { Text } = Typography;

const INITIAL_FILTERS: ICallFilters = { page: 1, limit: 20 };

function formatDuration(seconds: number | null): string {
	if (!seconds) {
		return "0:00";
	}
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function CallHistoryPage() {
	const navigate = useNavigate();
	const [filters, setFilters] = useState<ICallFilters>(INITIAL_FILTERS);
	const { data: callsData, isLoading, isFetching, isError, error, refetch } = useCalls(filters);
	const [isExporting, setIsExporting] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);

	// Narx ustuni faqat serverni ko'rsatishga rozi bo'lganda chiziladi; aks holda
	// bo'sh ustun "bu qo'ng'iroq tekin edi" degan taassurot berardi.
	const costVisible = callsData?.data.costVisible ?? false;

	const handleExport = async () => {
		setExportError(null);
		try {
			setIsExporting(true);
			const blob = await callService.export(filters);
			const url = window.URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `calls_export_${new Date().toISOString()}.csv`;
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
			title: "Qo'ng'iroq",
			key: "info",
			render: (_: unknown, record: CallListItem) => (
				<Space size="middle">
					<Avatar
						icon={<PhoneOutlined />}
						className={`${record.direction === "inbound" ? "bg-blue-50 text-blue-600" : "bg-purple-50 text-purple-600"} border border-current border-opacity-20`}
						size={40}
					/>
					<div className="flex flex-col">
						<span className="mb-1 font-bold leading-none text-slate-900">
							{record.contactName || formatPhone(record.callerNumber)}
						</span>
						<div className="flex items-center gap-2">
							<CallDirectionTag direction={record.direction} />
							<CallStatusBadge status={record.status} />
						</div>
					</div>
				</Space>
			),
		},
		{
			title: "Raqam",
			key: "callerNumber",
			render: (_: unknown, record: CallListItem) => (
				<span className="font-mono text-xs font-bold text-slate-700">
					{formatPhone(record.callerNumber)}
				</span>
			),
		},
		{
			title: "Operator",
			key: "operator",
			render: (_: unknown, record: CallListItem) => {
				// Operatorsiz qo'ng'iroqni AI olib borgan — bo'sh katak "ma'lumot
				// yo'q" degan taassurot berardi, holbuki bu aniq javob.
				if (record.operatorName === null) {
					return (
						<div className="flex flex-col">
							<Text type="secondary" className="text-xs font-semibold italic">
								AI operator
							</Text>
							<span className="font-mono text-[10px] text-slate-400">
								{record.calleeExtension ?? EMPTY_VALUE}
							</span>
						</div>
					);
				}
				return (
					<Space size="small">
						<Avatar size="small" icon={<UserOutlined />} className="bg-slate-100 text-slate-400" />
						<div className="flex flex-col">
							<span className="text-xs font-bold text-slate-900">{record.operatorName}</span>
							<span className="font-mono text-[10px] text-slate-400">
								{record.operatorExtension ?? record.calleeExtension ?? EMPTY_VALUE}
							</span>
						</div>
					</Space>
				);
			},
		},
		{
			title: "Davomiyligi",
			dataIndex: "duration",
			key: "duration",
			render: (duration: number | null) => (
				<div className="flex items-center gap-2 text-slate-500">
					<ClockCircleOutlined className="text-[12px]" />
					<span className="font-mono text-xs font-bold">{formatDuration(duration)}</span>
				</div>
			),
		},
		{
			title: "Yozuv va matn",
			key: "media",
			render: (_: unknown, record: CallListItem) => (
				<Space size="middle">
					<Tooltip title={record.hasRecording ? "Ovoz yozuvi bor" : "Ovoz yozuvi yo'q"}>
						<AudioOutlined className={record.hasRecording ? "text-blue-500" : "text-slate-200"} />
					</Tooltip>
					<Tooltip title={record.hasTranscript ? "Suhbat matni bor" : "Suhbat matni yo'q"}>
						<FileTextOutlined
							className={record.hasTranscript ? "text-emerald-500" : "text-slate-200"}
						/>
					</Tooltip>
				</Space>
			),
		},
		{
			title: "Sun'iy intellekt",
			key: "ai",
			render: (_: unknown, record: CallListItem) => (
				<div className="flex flex-col items-start gap-1">
					<AiStatusTag status={record.aiStatus} />
					<AiSentimentTag sentiment={record.sentiment} />
				</div>
			),
		},
		...(costVisible
			? [
					{
						title: "Narxi",
						key: "cost",
						align: "right" as const,
						render: (_: unknown, record: CallListItem) => (
							<span className="font-mono text-xs font-bold tabular-nums text-slate-700">
								{record.costUsd === null ? EMPTY_VALUE : formatUsd(record.costUsd)}
							</span>
						),
					},
				]
			: []),
		{
			title: "Sana va vaqt",
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
			<ActiveCallsSection />

			<div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-center">
				<div>
					<h1 className="text-3xl font-black tracking-tight text-slate-900">Qo'ng'iroqlar</h1>
					<p className="font-medium text-slate-500">
						Barcha kiruvchi va chiquvchi qo'ng'iroqlar tarixi. Qatorni bosing — yozuv, suhbat matni,
						AI tahlili va xarajat o'sha qo'ng'iroq kartasida.
					</p>
				</div>
			</div>

			<CallFilters
				filters={filters}
				onFiltersChange={(newFilters) => setFilters((f) => ({ ...f, ...newFilters }))}
				onReset={() => setFilters(INITIAL_FILTERS)}
				onRefresh={() => refetch()}
				onExport={handleExport}
				isExporting={isExporting}
				isFetching={isFetching}
			/>

			{isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Qo'ng'iroqlarni yuklab bo'lmadi"
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

			<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
				<Table
					columns={columns}
					dataSource={callsData?.data.items ?? []}
					loading={isLoading}
					rowKey="id"
					scroll={{ x: 1100 }}
					locale={{
						emptyText: (
							<Empty
								className="py-12"
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={isError ? "Ma'lumot yuklanmadi" : "Qo'ng'iroqlar topilmadi"}
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
					onRow={(record) => ({
						onClick: () => navigate(`/calls/${record.id}`),
						className: "cursor-pointer transition-colors",
					})}
				/>
			</Card>
		</div>
	);
}
