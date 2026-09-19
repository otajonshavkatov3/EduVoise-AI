import { DollarOutlined } from "@ant-design/icons";
import { Card, Tooltip } from "antd";
import { Link } from "react-router-dom";
import type { UnpricedReason } from "@/modules/ai-costs/types";
import {
	formatTokens,
	formatUsd,
	formatUzs,
	NO_DATA,
	NOT_APPLICABLE,
	UNPRICED_REASON_LABELS,
} from "@/modules/ai-costs/utils/format";
import type { AiSessionCost } from "../types";

function reasonLabel(reason: string | null): string | null {
	if (reason === null) {
		return null;
	}

	return UNPRICED_REASON_LABELS[reason as UnpricedReason] ?? reason;
}

/**
 * Two counters added only if both were reported.
 *
 * A missing cell is not a zero, so it cannot be summed away: treating it as 0
 * would turn "the provider never told us" into a measured token count, and
 * `null + number` would render NaN on the card.
 */
function addKnown(left: number | null, right: number | null): number | null {
	return left === null || right === null ? null : left + right;
}

function Line({ label, value, hint }: { label: string; value: string; hint?: string }) {
	// Both sentinels are prose, not figures, so neither takes the bold numeric style.
	const isEmpty = value === NO_DATA || value === NOT_APPLICABLE;

	return (
		<div className="flex items-baseline justify-between gap-3 border-b border-slate-50 py-2 last:border-b-0">
			<div className="min-w-0">
				<div className="text-xs font-bold text-slate-600">{label}</div>
				{hint && <div className="text-[10px] font-medium text-slate-400">{hint}</div>}
			</div>
			<div
				className={
					isEmpty
						? "shrink-0 text-[11px] font-bold italic text-slate-400"
						: "shrink-0 text-sm font-extrabold tabular-nums text-slate-900"
				}
			>
				{value}
			</div>
		</div>
	);
}

/**
 * What this one call cost, and why.
 *
 * Priced on read from the current rate table, exactly like the AI xarajatlari
 * page - so a corrected rate updates this card too. A line that cannot be
 * computed says "ma'lumot yo'q"; it never falls back to zero.
 */
export function SessionCostCard({ cost }: { cost: AiSessionCost }) {
	const uzs = formatUzs(cost.totalCostUzs);
	const unpriced = reasonLabel(cost.unpricedReason);
	// Each line is gated on its OWN data rather than on the total, because the
	// three are independently unknown: an eski sessiya reports no split at all,
	// while a session with unset rates reports the split and no money.
	const inputSplitKnown = cost.freshPromptTokens !== null && cost.cachedPromptTokens !== null;
	const audioTokens = addKnown(cost.freshAudioTokens, cost.cachedAudioTokens);
	const textTokens = addKnown(cost.freshTextTokens, cost.cachedTextTokens);
	const modalitySplitKnown = audioTokens !== null && textTokens !== null;

	return (
		<Card
			className="border-none shadow-sm rounded-2xl overflow-hidden"
			title={
				<div className="flex items-center gap-2 py-3">
					<DollarOutlined className="text-blue-600" />
					<span className="font-black text-slate-900">Qo'ng'iroq narxi</span>
				</div>
			}
			extra={
				cost.estimated && (
					<Tooltip title="Keshdan olingan tokenlarning matn/audio nisbati provayder tomonidan berilmaydi va taqsimlangan">
						<span className="rounded-md bg-amber-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-600">
							taxminiy
						</span>
					</Tooltip>
				)
			}
		>
			{unpriced && (
				<div className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-500">
					{unpriced}
				</div>
			)}

			<Line label="Ovozli suhbat modeli" value={formatUsd(cost.voiceCostUsd)} />
			<Line
				label="Transkripsiya"
				// Gemini transcribes inside the conversation, so there is no line to
				// price. Rendering its structural 0 as "$0.00" would read as a measured
				// charge of nothing rather than as a charge that does not exist.
				value={
					cost.transcriptionNotApplicable ? NOT_APPLICABLE : formatUsd(cost.transcriptionCostUsd)
				}
				hint="Alohida model — faqat OpenAI yo'lida"
			/>
			<Line
				label="Qo'ng'iroqdan keyingi tahlil"
				value={formatUsd(cost.analysisCostUsd)}
				hint={
					cost.analysisBilledRuns > 1
						? `${cost.analysisBilledRuns} marta ishlagan — hammasi qo'shilgan`
						: undefined
				}
			/>

			<div className="mt-3 flex items-baseline justify-between gap-3 rounded-xl bg-slate-50 px-3 py-3">
				<div>
					<div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Jami</div>
					{uzs && <div className="text-[11px] font-bold text-slate-500">{uzs}</div>}
				</div>
				<div
					className={
						cost.totalCostUsd === null
							? "text-xs font-bold italic text-slate-400"
							: "text-xl font-black tabular-nums text-slate-900"
					}
				>
					{formatUsd(cost.totalCostUsd)}
				</div>
			</div>

			{(cost.totalCostUsd !== null || inputSplitKnown) && (
				<div className="mt-3 flex flex-col gap-1 text-[11px] font-medium text-slate-400">
					{cost.totalCostUsd !== null && (
						<div>
							Bir daqiqasi:{" "}
							<span className="font-bold text-slate-600">{formatUsd(cost.costPerMinuteUsd)}</span>
						</div>
					)}
					{inputSplitKnown && (
						<div>
							Kirish tokenlari:{" "}
							<span className="font-bold text-slate-600">
								{formatTokens(cost.freshPromptTokens)} yangi
							</span>{" "}
							+{" "}
							<span className="font-bold text-slate-600">
								{formatTokens(cost.cachedPromptTokens)} keshdan
							</span>
							{cost.cachedSharePct !== null && ` (${cost.cachedSharePct}% kesh)`}
						</div>
					)}
					{modalitySplitKnown && (
						<div>
							Taqsimot: {formatTokens(audioTokens)} audio · {formatTokens(textTokens)} matn
						</div>
					)}
				</div>
			)}

			<div className="mt-4 border-t border-slate-50 pt-3 text-[10px] font-medium text-slate-400">
				Narx saqlanmaydi — har safar{" "}
				<Link to="/settings" className="font-bold">
					joriy narxlar
				</Link>{" "}
				bo'yicha qayta hisoblanadi.{" "}
				<Link to="/ai-costs" className="font-bold">
					Barcha xarajatlar
				</Link>
			</div>
		</Card>
	);
}
