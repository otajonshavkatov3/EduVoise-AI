import { Card, Empty, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ProviderSplitRow } from "../types";
import {
	formatDuration,
	formatPercent,
	formatTokensShort,
	formatUsd,
	NO_DATA,
	NOT_APPLICABLE,
	providerLabel,
} from "../utils/format";

const { Text } = Typography;

function CostCell({ value }: { value: number | null }) {
	if (value === null) {
		return <Text className="text-[11px] italic text-slate-400">{NO_DATA}</Text>;
	}

	return <span className="text-xs font-bold tabular-nums text-slate-900">{formatUsd(value)}</span>;
}

const columns: ColumnsType<ProviderSplitRow> = [
	{
		title: "Provayder",
		key: "provider",
		width: 200,
		fixed: "left",
		render: (_, row) => (
			<div className="flex flex-col gap-1">
				<span className="font-bold text-slate-900">{providerLabel(row.provider)}</span>
				<span className="text-[11px] font-medium text-slate-500">
					{row.model ?? "model yozilmagan"}
				</span>
			</div>
		),
	},
	{
		title: "Sessiyalar",
		key: "sessions",
		width: 130,
		align: "right",
		render: (_, row) => (
			<div className="flex flex-col items-end">
				<span className="text-sm font-black tabular-nums text-slate-900">{row.sessions}</span>
				{row.pricedSessions < row.sessions && (
					<Tooltip title="Qolganlarida narx hisoblash uchun ma'lumot yetarli emas">
						<span className="text-[10px] font-bold text-slate-400">
							{row.pricedSessions} tasida hisoblangan
						</span>
					</Tooltip>
				)}
			</div>
		),
	},
	{
		title: "Suhbat vaqti",
		key: "callSeconds",
		width: 110,
		align: "right",
		render: (_, row) => (
			<span className="text-xs font-bold tabular-nums text-slate-700">
				{formatDuration(row.callSeconds)}
			</span>
		),
	},
	{
		title: "Kirish tokenlari",
		key: "promptTokens",
		width: 140,
		align: "right",
		render: (_, row) => (
			<span className="text-xs font-bold tabular-nums text-slate-700">
				{formatTokensShort(row.voice.promptTokens)}
			</span>
		),
	},
	{
		title: "Chiqish tokenlari",
		key: "completionTokens",
		width: 150,
		align: "right",
		render: (_, row) => (
			<span className="text-xs font-bold tabular-nums text-slate-700">
				{formatTokensShort(row.voice.completionTokens)}
			</span>
		),
	},
	{
		title: "Kesh ulushi",
		key: "cachedSharePct",
		width: 120,
		align: "right",
		// Unknown must not wear the bold numeric style a real percentage wears.
		render: (_, row) =>
			row.voice.cachedSharePct === null ? (
				<Text className="text-[11px] italic text-slate-400">{NO_DATA}</Text>
			) : (
				<span className="text-xs font-bold tabular-nums text-slate-700">
					{formatPercent(row.voice.cachedSharePct)}
				</span>
			),
	},
	{
		title: "Ovoz",
		key: "voiceCost",
		width: 110,
		align: "right",
		render: (_, row) => <CostCell value={row.voice.costUsd} />,
	},
	{
		title: "Transkripsiya",
		key: "transcriptionCost",
		width: 140,
		align: "right",
		render: (_, row) =>
			row.transcription.notApplicableSessions === row.sessions ? (
				<Tooltip title="Bu provayder transkripsiyani suhbat ichida bajaradi — alohida to'lov yo'q">
					<Text className="text-[11px] italic text-slate-400">{NOT_APPLICABLE}</Text>
				</Tooltip>
			) : (
				<CostCell value={row.transcription.costUsd} />
			),
	},
	{
		title: "Tahlil",
		key: "analysisCost",
		width: 110,
		align: "right",
		render: (_, row) => <CostCell value={row.analysis.costUsd} />,
	},
	{
		title: "Jami",
		key: "costUsd",
		width: 130,
		align: "right",
		render: (_, row) => (
			<div className="flex flex-col items-end gap-1">
				<CostCell value={row.costUsd} />
				{row.voice.estimated && row.costUsd !== null && (
					<Tag color="orange" className="m-0 rounded text-[9px] font-bold uppercase">
						taxminiy
					</Tag>
				)}
			</div>
		),
	},
	{
		title: "Bir daqiqasi",
		key: "costPerMinuteUsd",
		width: 120,
		align: "right",
		render: (_, row) => <CostCell value={row.costPerMinuteUsd} />,
	},
];

/**
 * Provider against provider, which is the comparison worth having now that two
 * speech-to-speech backends are wired up and either can answer the phone.
 */
export function ProviderSplitTable({
	rows,
	isLoading,
}: {
	rows: ProviderSplitRow[];
	isLoading: boolean;
}) {
	return (
		<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
			<div className="px-6 pb-2 pt-5">
				<h3 className="text-lg font-extrabold tracking-tight text-slate-900">
					Provayder va model kesimi
				</h3>
				<p className="text-xs font-medium text-slate-500">
					Transkripsiya va tahlil xarajatlari faqat OpenAI yo'liga tegishli — Gemini qatoriga
					kirmaydi. Model ustuni sessiya yozuvidan olinadi, narx esa provayder bo'yicha belgilanadi.
				</p>
			</div>
			<Table<ProviderSplitRow>
				columns={columns}
				dataSource={rows}
				loading={isLoading}
				rowKey={(row) => `${row.provider}::${row.model ?? ""}`}
				size="middle"
				scroll={{ x: 1460 }}
				pagination={false}
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
