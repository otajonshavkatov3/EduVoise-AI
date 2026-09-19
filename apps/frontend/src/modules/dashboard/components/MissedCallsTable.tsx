import { Card, Empty, Spin, Table, Tag, Typography } from "antd";
import type { DashboardMissedCall, DashboardPeriod } from "../types";
import { refetchOpacity } from "../utils/chartTheme";
import { formatDate, formatDuration, PERIOD_PHRASES } from "../utils/format";

const { Text } = Typography;

interface MissedCallsTableProps {
	items: DashboardMissedCall[];
	/** Oraliqdagi umumiy javobsiz qo'ng'iroqlar soni (ko'rsatilgan limitdan ko'p bo'lishi mumkin). */
	total: number;
	period: DashboardPeriod;
	isLoading: boolean;
	isFetching: boolean;
}

/** Haqiqiy status → o'zbekcha yorliq. "Sabab" to'qib chiqarilmaydi. */
const STATUS_LABELS: Record<DashboardMissedCall["status"], string> = {
	missed: "O'tkazib yuborilgan",
	abandoned: "Tashlab ketilgan",
};

const DIRECTION_LABELS: Record<DashboardMissedCall["direction"], string> = {
	inbound: "Kiruvchi",
	outbound: "Chiquvchi",
};

export function MissedCallsTable({
	items,
	total,
	period,
	isLoading,
	isFetching,
}: MissedCallsTableProps) {
	const columns = [
		{
			title: "Qo'ng'iroq qiluvchi",
			key: "caller",
			render: (_: unknown, record: DashboardMissedCall) => (
				<div className="flex flex-col">
					<Text className="text-xs font-bold text-slate-900">
						{record.contactName ?? "Noma'lum kontakt"}
					</Text>
					<Text type="secondary" className="font-mono text-[11px]">
						{record.callerNumber}
					</Text>
				</div>
			),
		},
		{
			// Holat ataylab chapda: jadval sahifaning eng oxirida turadi va o'ng
			// pastki burchakni global "qo'ng'iroq qilish" tugmasi to'sib qo'yadi.
			title: "Holat",
			dataIndex: "status",
			key: "status",
			render: (status: DashboardMissedCall["status"]) => (
				<Tag
					className={`rounded-full border py-0 text-[10px] font-bold uppercase tracking-wider ${
						status === "missed"
							? "border-rose-100 bg-rose-50 text-rose-600"
							: "border-amber-100 bg-amber-50 text-amber-600"
					}`}
				>
					{STATUS_LABELS[status]}
				</Tag>
			),
		},
		{
			title: "Yo'nalish",
			dataIndex: "direction",
			key: "direction",
			render: (direction: DashboardMissedCall["direction"]) => (
				<span className="text-xs font-medium text-slate-600">{DIRECTION_LABELS[direction]}</span>
			),
		},
		{
			title: "Ichki raqam",
			key: "extension",
			render: (_: unknown, record: DashboardMissedCall) => (
				<span className="font-mono text-xs text-slate-500">
					{record.operatorExtension ?? record.calleeExtension ?? "—"}
				</span>
			),
		},
		{
			title: "Vaqti",
			dataIndex: "startedAt",
			key: "startedAt",
			render: (startedAt: string) => (
				<div className="flex flex-col">
					<span className="text-xs font-bold text-slate-600">
						{new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
					</span>
					<span className="text-[10px] text-slate-400">{formatDate(startedAt)}</span>
				</div>
			),
		},
		{
			title: "Jiringlagan vaqt",
			dataIndex: "ringSec",
			key: "ringSec",
			render: (ringSec: number | null) => (
				<span className="text-xs font-medium tabular-nums text-slate-600">
					{formatDuration(ringSec)}
				</span>
			),
		},
	];

	return (
		<Card
			className="border-slate-100 shadow-sm"
			styles={{ body: { padding: 0 } }}
			title={
				<div className="flex flex-col gap-1 py-4">
					<span className="text-lg font-extrabold tracking-tight text-slate-900">
						Javobsiz qo'ng'iroqlar
					</span>
					<span className="text-xs font-medium text-slate-500">
						{total > 0
							? `${PERIOD_PHRASES[period]}: jami ${total} ta, oxirgi ${items.length} tasi ko'rsatilgan`
							: `Javobsiz qo'ng'iroqlar (${PERIOD_PHRASES[period]})`}
					</span>
				</div>
			}
		>
			{isLoading && (
				<div className="flex min-h-[220px] items-center justify-center" aria-busy="true">
					<Spin size="large" />
				</div>
			)}

			{!isLoading && items.length === 0 && (
				<div className="flex min-h-[220px] items-center justify-center">
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description={
							<div className="text-center">
								<div className="font-bold text-slate-500">Javobsiz qo'ng'iroq yo'q</div>
								<div className="mt-1 text-xs text-slate-400">
									Barcha qo'ng'iroqlarga javob berilgan
								</div>
							</div>
						}
					/>
				</div>
			)}

			{!isLoading && items.length > 0 && (
				<div className={refetchOpacity(isFetching)}>
					<Table
						columns={columns}
						dataSource={items}
						rowKey="id"
						pagination={false}
						size="middle"
						scroll={{ x: "max-content" }}
					/>
				</div>
			)}
		</Card>
	);
}
