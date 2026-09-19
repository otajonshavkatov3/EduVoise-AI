import {
	ClockCircleOutlined,
	DatabaseOutlined,
	DollarOutlined,
	PhoneOutlined,
	ThunderboltOutlined,
} from "@ant-design/icons";
import { Card, Tooltip } from "antd";
import type { ReactNode } from "react";
import type { CostTotals } from "../types";
import {
	formatDuration,
	formatPercent,
	formatTokensShort,
	formatUsd,
	formatUzs,
	NO_DATA,
} from "../utils/format";

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
	/** Taxminiy qiymat — sarlavha yonida ko'rsatiladi. */
	estimated?: boolean;
	tooltip?: string;
}

function StatTile({ title, value, icon, tone, hint, estimated, tooltip }: Tile) {
	const isEmpty = value === NO_DATA;

	const body = (
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
				<div className="flex items-center gap-2">
					<div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
						{title}
					</div>
					{estimated && !isEmpty && (
						<span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-600">
							taxminiy
						</span>
					)}
				</div>
				{hint && <div className="mt-1 text-[11px] font-medium text-slate-400">{hint}</div>}
			</div>
		</Card>
	);

	return tooltip ? <Tooltip title={tooltip}>{body}</Tooltip> : body;
}

/** Namuna soni yozilmasa "o'rtacha" qaysi qatorlardan olingani tushunarsiz bo'ladi. */
function pricedHint(totals: CostTotals): string {
	if (totals.pricedSessions === 0) {
		return `${totals.sessions} sessiyaning hech birida narx hisoblanmadi`;
	}

	return totals.pricedSessions === totals.sessions
		? `${totals.pricedSessions} sessiya asosida`
		: `${totals.pricedSessions} / ${totals.sessions} sessiyada narx hisoblangan`;
}

/**
 * The headline covers every line of money that is known, which includes the
 * analysis and transcription of sessions whose voice line could not be priced. So
 * it can show a real figure while pricedSessions is still zero - and pricedHint,
 * which describes the AVERAGES' narrower sample, would then deny under a dollar
 * amount that anything was priced at all.
 */
function totalHint(totals: CostTotals): string {
	if (totals.costUsd !== null && totals.pricedSessions === 0) {
		return "ovozli qatorlar narxlanmagan — faqat tahlil va transkripsiya xarajati";
	}

	return pricedHint(totals);
}

export function CostSummaryTiles({ totals }: { totals: CostTotals }) {
	const uzs = formatUzs(totals.costUzs);
	const estimated = totals.voice.estimated;

	const tiles: Tile[] = [
		{
			title: "Oraliqdagi xarajat",
			value: formatUsd(totals.costUsd),
			icon: <DollarOutlined />,
			tone: totals.costUsd === null ? "neutral" : "info",
			hint: uzs ?? totalHint(totals),
			estimated,
			tooltip:
				uzs === null
					? "So'mdagi qiymat uchun Sozlamalar → Narxlar bo'limida dollar kursini kiriting"
					: totalHint(totals),
		},
		{
			title: "Bitta qo'ng'iroq",
			value: formatUsd(totals.costPerCallUsd),
			icon: <PhoneOutlined />,
			tone: totals.costPerCallUsd === null ? "neutral" : "neutral",
			hint: pricedHint(totals),
			estimated,
		},
		{
			title: "Bir daqiqasi",
			value: formatUsd(totals.costPerMinuteUsd),
			icon: <ClockCircleOutlined />,
			tone: "neutral",
			// Rounding the sample to whole minutes printed "0 daqiqasi" underneath a
			// live per-minute figure on the first short call, which reads as a
			// division by nothing.
			hint:
				totals.pricedCallSeconds > 0
					? `narxi hisoblangan ${formatDuration(totals.pricedCallSeconds)} suhbat bo'yicha`
					: "Narxi hisoblangan suhbat yo'q",
			estimated,
			tooltip: "Faqat narxi hisoblangan sessiyalar davomiyligiga bo'linadi",
		},
		{
			title: "Jami tokenlar",
			value: formatTokensShort(totals.voice.promptTokens + totals.voice.completionTokens),
			icon: <DatabaseOutlined />,
			tone: "neutral",
			hint: `${formatTokensShort(totals.voice.promptTokens)} kirish · ${formatTokensShort(totals.voice.completionTokens)} chiqish`,
			tooltip: "Token soni har bir sessiyada qayd etilgan — narx kiritilmagan bo'lsa ham ko'rinadi",
		},
		{
			title: "Keshdan olingan",
			value: formatPercent(totals.voice.cachedSharePct),
			icon: <ThunderboltOutlined />,
			tone: totals.voice.cachedSharePct === null ? "neutral" : "good",
			hint:
				totals.voice.breakdownSessions > 0
					? `${totals.voice.breakdownSessions} ta sessiya taqsimoti bo'yicha`
					: "Taqsimot yozilgan sessiya yo'q",
			tooltip:
				"Keshdan olingan kirish tokenlari ancha arzon. Ulush qancha yuqori bo'lsa, qo'ng'iroq shuncha arzon tushadi.",
		},
	];

	return (
		<div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
			{tiles.map((tile) => (
				<StatTile key={tile.title} {...tile} />
			))}
		</div>
	);
}
