import { Card, Empty, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { Link } from "react-router-dom";
import type { CostCallRow, PaginationMeta } from "../types";
import {
	formatDateTime,
	formatDurationMs,
	formatPercent,
	formatPhone,
	formatTokensShort,
	formatUsd,
	NO_DATA,
	providerLabel,
	unpricedReasonLabel,
} from "../utils/format";

const { Text } = Typography;

interface Props {
	rows: CostCallRow[];
	meta?: PaginationMeta;
	isLoading: boolean;
	onPageChange: (page: number, limit: number) => void;
}

/** Narxi hisoblanmagan qiymat — 0 emas, sababi bilan. */
function CostCell({ value, reason }: { value: number | null; reason?: string | null }) {
	if (value === null) {
		const label = <Text className="text-[11px] italic text-slate-400">{NO_DATA}</Text>;

		return reason ? <Tooltip title={reason}>{label}</Tooltip> : label;
	}

	return <span className="text-xs font-bold tabular-nums text-slate-900">{formatUsd(value)}</span>;
}

function NumberCell({ value }: { value: number | null }) {
	if (value === null) {
		return <Text className="text-[11px] italic text-slate-400">{NO_DATA}</Text>;
	}

	return <span className="text-xs font-bold tabular-nums text-slate-700">{value}</span>;
}

const columns: ColumnsType<CostCallRow> = [
	{
		title: "Qo'ng'iroq",
		key: "call",
		width: 210,
		fixed: "left",
		render: (_, row) => (
			<div className="flex flex-col gap-1">
				<Link
					to={`/ai-assistant/sessions/${row.sessionId}`}
					className="font-bold text-slate-900 hover:text-blue-600"
				>
					{formatPhone(row.callerNumber)}
				</Link>
				<span className="text-[11px] font-medium text-slate-500">
					{formatDateTime(row.startedAt)}
				</span>
			</div>
		),
	},
	{
		title: "Jami narx",
		key: "totalCostUsd",
		width: 130,
		align: "right",
		render: (_, row) => (
			<div className="flex flex-col items-end gap-1">
				<CostCell value={row.totalCostUsd} reason={unpricedReasonLabel(row.unpricedReason)} />
				{row.estimated && row.totalCostUsd !== null && (
					<Tooltip title="Kirish narxi kesh taqsimotiga asoslangan — aniq o'lchov emas">
						<span className="rounded bg-amber-50 px-1.5 text-[9px] font-bold uppercase tracking-wider text-amber-600">
							taxminiy
						</span>
					</Tooltip>
				)}
			</div>
		),
	},
	{
		title: "Bir daqiqasi",
		key: "costPerMinuteUsd",
		width: 110,
		align: "right",
		render: (_, row) => <CostCell value={row.costPerMinuteUsd} />,
	},
	{
		title: "Davomiyligi",
		key: "durationMs",
		width: 110,
		align: "right",
		render: (_, row) => (
			<span className="text-xs font-bold tabular-nums text-slate-700">
				{formatDurationMs(row.durationMs)}
			</span>
		),
	},
	{
		title: "Javoblar",
		key: "responseTurns",
		width: 100,
		align: "right",
		render: (_, row) => <NumberCell value={row.responseTurns} />,
	},
	{
		title: "Kesh ulushi",
		key: "cachedSharePct",
		width: 120,
		align: "right",
		render: (_, row) =>
			row.cachedSharePct === null ? (
				<Tooltip title="Bu sessiyada kesh taqsimoti yozilmagan">
					<Text className="text-[11px] italic text-slate-400">{NO_DATA}</Text>
				</Tooltip>
			) : (
				<span
					className={
						row.cachedSharePct >= 50
							? "text-xs font-bold tabular-nums text-emerald-600"
							: "text-xs font-bold tabular-nums text-amber-600"
					}
				>
					{formatPercent(row.cachedSharePct)}
				</span>
			),
	},
	{
		title: "Chiquvchi audio",
		key: "outputAudioTokens",
		width: 140,
		align: "right",
		render: (_, row) => (
			<Tooltip title="Model gapirgan ovoz — odatda eng qimmat qator">
				{row.outputAudioTokens === null ? (
					<Text className="text-[11px] italic text-slate-400">{NO_DATA}</Text>
				) : (
					<span className="text-xs font-bold tabular-nums text-slate-700">
						{formatTokensShort(row.outputAudioTokens)}
					</span>
				)}
			</Tooltip>
		),
	},
	{
		title: "Ovoz",
		key: "voiceCostUsd",
		width: 110,
		align: "right",
		render: (_, row) => <CostCell value={row.voiceCostUsd} />,
	},
	{
		title: "Transkripsiya",
		key: "transcriptionCostUsd",
		width: 130,
		align: "right",
		render: (_, row) => <CostCell value={row.transcriptionCostUsd} />,
	},
	{
		title: "Tahlil",
		key: "analysisCostUsd",
		width: 110,
		align: "right",
		render: (_, row) => <CostCell value={row.analysisCostUsd} />,
	},
	{
		title: "Provayder",
		key: "provider",
		width: 190,
		render: (_, row) => (
			<div className="flex flex-col gap-1">
				<Tag color="blue" className="w-fit rounded-md font-bold">
					{providerLabel(row.provider)}
				</Tag>
				<span className="text-[11px] font-medium text-slate-400">{row.model ?? "—"}</span>
			</div>
		),
	},
];

/**
 * The cost column alone answers "how much"; the columns beside it answer "why".
 * A long call with many turns and a cold cache is a different problem from a
 * short one with a large audio output, and the fix is different too.
 */
export function ExpensiveCallsTable({ rows, meta, isLoading, onPageChange }: Props) {
	const pagination: TablePaginationConfig = {
		current: meta?.page ?? 1,
		pageSize: meta?.limit ?? 20,
		total: meta?.total ?? 0,
		showSizeChanger: true,
		showTotal: (total, range) => `${range[0]}–${range[1]} / jami ${total}`,
		className: "px-6 pb-4",
		onChange: onPageChange,
	};

	return (
		<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
			<Table<CostCallRow>
				columns={columns}
				dataSource={rows}
				loading={isLoading}
				rowKey="sessionId"
				size="middle"
				scroll={{ x: 1560 }}
				pagination={pagination}
				locale={{
					emptyText: (
						<Empty
							className="py-12"
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description="Tanlangan oraliqda AI sessiya topilmadi"
						/>
					),
				}}
			/>
		</Card>
	);
}
