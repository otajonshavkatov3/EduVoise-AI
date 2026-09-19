import {
	CheckCircleOutlined,
	ClockCircleOutlined,
	CustomerServiceOutlined,
	FileTextOutlined,
	HourglassOutlined,
	PhoneOutlined,
	PieChartOutlined,
	TeamOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import { Card } from "antd";
import type { ReactNode } from "react";
import type { CallsSummary, OperatorsSummary, TicketsSummary } from "../types";
import { formatDuration, formatHours, formatPercent, NO_DATA } from "../utils/format";

type Tone = "neutral" | "good" | "warn" | "bad" | "info";

const toneClasses: Record<Tone, string> = {
	neutral: "bg-slate-50 text-slate-400",
	good: "bg-emerald-50 text-emerald-600",
	warn: "bg-amber-50 text-amber-600",
	bad: "bg-rose-50 text-rose-600",
	info: "bg-blue-50 text-blue-600",
};

interface Tile {
	title: string;
	value: string;
	icon: ReactNode;
	tone: Tone;
	hint?: string;
}

function StatTile({ title, value, icon, tone, hint }: Tile) {
	const isEmpty = value === NO_DATA;

	return (
		<Card
			className="border-slate-100 shadow-sm transition-shadow hover:shadow-md"
			styles={{ body: { padding: 20 } }}
		>
			<div className="flex items-center justify-between gap-3">
				<div
					className={`flex h-12 w-12 items-center justify-center rounded-xl text-base ${toneClasses[tone]}`}
				>
					{icon}
				</div>
				<div
					className={
						isEmpty
							? "text-right text-xs font-bold italic text-slate-400"
							: "text-2xl font-extrabold tabular-nums text-slate-900"
					}
				>
					{value}
				</div>
			</div>
			<div className="mt-4">
				<div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</div>
				{hint && <div className="mt-1 text-[11px] font-medium text-slate-400">{hint}</div>}
			</div>
		</Card>
	);
}

function TileGrid({ tiles }: { tiles: Tile[] }) {
	return (
		<div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
			{tiles.map((tile) => (
				<StatTile key={tile.title} {...tile} />
			))}
		</div>
	);
}

/** Namuna soni yozilmasa "o'rtacha" qaysi qatorlardan olingani tushunarsiz bo'ladi. */
function sampleHint(sampleCount: number, noun: string): string {
	return sampleCount > 0 ? `${sampleCount} ${noun} asosida` : `${noun} yo'q`;
}

export function CallsSummaryTiles({ summary }: { summary: CallsSummary }) {
	return (
		<TileGrid
			tiles={[
				{
					title: "Jami qo'ng'iroq",
					value: String(summary.totalCalls),
					icon: <PhoneOutlined />,
					tone: "info",
					hint: `${summary.inboundCalls} kiruvchi · ${summary.outboundCalls} chiquvchi`,
				},
				{
					title: "Javob berilgan",
					value: String(summary.answeredCalls),
					icon: <CheckCircleOutlined />,
					tone: summary.answeredCalls > 0 ? "good" : "neutral",
					hint: `Javob berish darajasi: ${formatPercent(summary.answeredRate)}`,
				},
				{
					title: "O'tkazib yuborilgan",
					value: String(summary.missedCalls),
					icon: <WarningOutlined />,
					tone: summary.missedCalls > 0 ? "bad" : "neutral",
					hint: `${summary.abandonedCalls} ta tashlab ketilgan`,
				},
				{
					title: "O'rtacha suhbat",
					value: formatDuration(summary.avgTalkSeconds),
					icon: <ClockCircleOutlined />,
					tone: "neutral",
					hint: sampleHint(summary.talkSampleCount, "javob berilgan qo'ng'iroq"),
				},
				{
					title: "O'rtacha kutish",
					value: formatDuration(summary.avgWaitSeconds),
					icon: <HourglassOutlined />,
					tone: "neutral",
					hint: sampleHint(summary.waitSampleCount, "javob vaqti yozilgan qo'ng'iroq"),
				},
			]}
		/>
	);
}

export function TicketsSummaryTiles({ summary }: { summary: TicketsSummary }) {
	const analysed = summary.sentimentPositive + summary.sentimentNeutral + summary.sentimentNegative;

	return (
		<TileGrid
			tiles={[
				{
					title: "Jami murojaat",
					value: String(summary.totalTickets),
					icon: <FileTextOutlined />,
					tone: "info",
					hint: `${summary.statusNew} yangi · ${summary.statusInProgress} jarayonda`,
				},
				{
					title: "Yopilgan",
					value: String(summary.statusClosed),
					icon: <CheckCircleOutlined />,
					tone: summary.statusClosed > 0 ? "good" : "neutral",
					hint: `Yopilish darajasi: ${formatPercent(summary.closedRate)}`,
				},
				{
					title: "Qayta ochilgan",
					value: String(summary.statusReopened),
					icon: <WarningOutlined />,
					tone: summary.statusReopened > 0 ? "warn" : "neutral",
					hint: `${summary.statusResolved} ta hal qilingan`,
				},
				{
					title: "O'rtacha hal qilish",
					value: formatHours(summary.avgResolutionHours),
					icon: <ClockCircleOutlined />,
					tone: "neutral",
					hint: sampleHint(summary.resolutionSampleCount, "yopilgan murojaat"),
				},
				{
					title: "Yuqori prioritet",
					value: String(summary.priorityHigh),
					icon: <PieChartOutlined />,
					tone: summary.priorityHigh > 0 ? "bad" : "neutral",
					hint:
						analysed > 0
							? `AI tahlili: ${analysed} ta (${summary.sentimentNegative} manfiy)`
							: "AI tahlili yo'q",
				},
			]}
		/>
	);
}

export function OperatorsSummaryTiles({ summary }: { summary: OperatorsSummary }) {
	return (
		<TileGrid
			tiles={[
				{
					title: "Operatorlar",
					value: String(summary.operatorCount),
					icon: <TeamOutlined />,
					tone: "info",
					hint: "Oraliqda faoliyati bo'lgan yoki faol profillar",
				},
				{
					title: "Jami qo'ng'iroq",
					value: String(summary.totalCalls),
					icon: <PhoneOutlined />,
					tone: "neutral",
					hint: `${summary.unassignedCalls} ta operatorga bog'lanmagan (jadvalda yo'q)`,
				},
				{
					title: "Javob berish darajasi",
					value: formatPercent(summary.answeredRate),
					icon: <CheckCircleOutlined />,
					tone: summary.answeredCalls > 0 ? "good" : "neutral",
					hint: `${summary.answeredCalls} javob · ${summary.missedCalls} o'tkazib yuborilgan`,
				},
				{
					title: "O'rtacha suhbat",
					value: formatDuration(summary.avgTalkSeconds),
					icon: <ClockCircleOutlined />,
					tone: "neutral",
					hint: sampleHint(summary.talkSampleCount, "javob berilgan qo'ng'iroq"),
				},
				{
					title: "Yaratilgan murojaat",
					value: String(summary.ticketsCreated),
					icon: <CustomerServiceOutlined />,
					tone: "neutral",
					hint: "Operator hisobidan oraliq ichida yaratilgan",
				},
			]}
		/>
	);
}
