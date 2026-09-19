import { Alert, Card, Empty, Tooltip } from "antd";
import { CHART_COLORS } from "@/modules/dashboard/utils/chartTheme";
import type { TokenBuckets } from "../types";
import { formatTokens, formatTokensShort } from "../utils/format";

interface Segment {
	label: string;
	value: number;
	color: string;
	hint: string;
}

/** A 100%-proportion bar. Zero-width segments are dropped so labels cannot collide. */
function ProportionBar({ segments, total }: { segments: Segment[]; total: number }) {
	const visible = segments.filter((segment) => segment.value > 0);

	return (
		<div className="flex h-6 w-full overflow-hidden rounded-lg bg-slate-100">
			{visible.map((segment) => (
				<Tooltip
					key={segment.label}
					title={`${segment.label}: ${formatTokens(segment.value)} token — ${segment.hint}`}
				>
					<div
						className="h-full transition-all"
						style={{
							width: `${(segment.value / total) * 100}%`,
							backgroundColor: segment.color,
						}}
					/>
				</Tooltip>
			))}
		</div>
	);
}

function Legend({ segments, total }: { segments: Segment[]; total: number }) {
	return (
		<div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
			{segments.map((segment) => (
				<div key={segment.label} className="flex items-center gap-2">
					<span
						className="h-3 w-3 shrink-0 rounded-full"
						style={{ backgroundColor: segment.color }}
					/>
					<span className="text-xs font-bold text-slate-600">{segment.label}</span>
					<span className="text-xs font-bold tabular-nums text-slate-900">
						{formatTokensShort(segment.value)}
					</span>
					<span className="text-[11px] font-medium text-slate-400">
						{total > 0 ? `${Math.round((segment.value / total) * 100)}%` : "—"}
					</span>
				</div>
			))}
		</div>
	);
}

function Axis({
	title,
	subtitle,
	segments,
	total,
}: {
	title: string;
	subtitle: string;
	segments: Segment[];
	total: number;
}) {
	return (
		<div>
			<div className="mb-2 flex items-baseline justify-between gap-3">
				<div>
					<div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
						{title}
					</div>
					<div className="text-[11px] font-medium text-slate-400">{subtitle}</div>
				</div>
				<div className="text-sm font-extrabold tabular-nums text-slate-900">
					{formatTokens(total)}
				</div>
			</div>
			<ProportionBar segments={segments} total={total} />
			<Legend segments={segments} total={total} />
		</div>
	);
}

/**
 * Why a call cost what it did, in tokens.
 *
 * The input side is drawn as TWO bars, not one stack, because the provider
 * reports two independent marginals over the same tokens - cache (fresh vs
 * cached) and modality (text vs audio) - and never the four cells where they
 * cross. Each bar totals the prompt count on its own; adding the two together
 * would double-count every token. The banner says so, because a five-slice stack
 * is exactly the mistake a reader would otherwise make.
 *
 * The output side genuinely is one bar: audio + text sum to the completion count.
 */
export function TokenBreakdownCard({ voice }: { voice: TokenBuckets }) {
	const promptTotal = voice.freshPromptTokens + voice.cachedPromptTokens;
	const modalityTotal = voice.inputTextTokens + voice.inputAudioTokens;
	const outputTotal = voice.outputTextTokens + voice.outputAudioTokens;

	if (voice.breakdownSessions === 0) {
		return (
			<Card className="h-full border-slate-100 shadow-sm" styles={{ body: { padding: 24 } }}>
				<h3 className="text-lg font-extrabold tracking-tight text-slate-900">Token taqsimoti</h3>
				<p className="mb-6 text-xs font-medium text-slate-500">
					Narx qanday shakllangani — kesh hamda audio/matn kesimida
				</p>
				<div className="flex min-h-[280px] items-center justify-center">
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description={
							<div className="text-center">
								<div className="font-bold text-slate-500">Taqsimot yozilgan sessiya yo'q</div>
								<div className="mt-1 text-xs text-slate-400">
									Eski sessiyalarda faqat umumiy token soni bor. Yangi qo'ng'iroqlar to'liq
									taqsimotni yozadi.
								</div>
							</div>
						}
					/>
				</div>
			</Card>
		);
	}

	return (
		<Card className="h-full border-slate-100 shadow-sm" styles={{ body: { padding: 24 } }}>
			<div className="mb-4">
				<h3 className="text-lg font-extrabold tracking-tight text-slate-900">Token taqsimoti</h3>
				<p className="text-xs font-medium text-slate-500">
					{voice.breakdownSessions} ta sessiya bo'yicha — narx aynan shu sonlardan hisoblanadi
				</p>
			</div>

			<Alert
				type="info"
				showIcon
				className="mb-6 rounded-xl"
				message="Kirish tomonida ikkita mustaqil o'lchov bor"
				description={
					// The two axes are separate views of the same tokens, so adding them is
					// always wrong. They are not always equal, though: Gemini's modality
					// figures can fall short of the prompt total, and claiming otherwise was
					// visibly false on screen (8 706 against 9 145 on a real call).
					modalityTotal < promptTotal
						? `Quyidagi ikkala chiziq ham aynan bir xil tokenlarni ko'rsatadi, faqat boshqa nuqtai nazardan — ularni bir-biriga qo'shmang. Provayder audio/matn kesimida ${formatTokens(promptTotal - modalityTotal)} tokenni ochiq qoldirgan; ular matn tarifida hisoblangan.`
						: "Quyidagi ikkala chiziq ham aynan bir xil tokenlarni ko'rsatadi, faqat boshqa nuqtai nazardan. Ularni bir-biriga qo'shmang — har biri alohida holda umumiy kirish tokenlari soniga teng."
				}
			/>

			<div className="flex flex-col gap-6">
				<Axis
					title="Kirish — kesh bo'yicha"
					subtitle="Keshdan olingan tokenlar ancha arzon"
					total={promptTotal}
					segments={[
						{
							label: "Yangi",
							value: voice.freshPromptTokens,
							color: CHART_COLORS.unanswered,
							hint: "to'liq narxda hisoblanadi",
						},
						{
							label: "Keshdan",
							value: voice.cachedPromptTokens,
							color: CHART_COLORS.positive,
							hint: "arzon tarif bo'yicha hisoblanadi",
						},
					]}
				/>

				<Axis
					title="Kirish — audio va matn bo'yicha"
					subtitle="Audio tokenlar matndan bir necha barobar qimmat"
					total={modalityTotal}
					segments={[
						{
							label: "Audio",
							value: voice.inputAudioTokens,
							color: CHART_COLORS.series,
							hint: "mijoz ovozi",
						},
						{
							label: "Matn",
							value: voice.inputTextTokens,
							color: CHART_COLORS.neutral,
							hint: "yo'riqnoma, bilimlar bazasi, vositalar",
						},
					]}
				/>

				<div className="border-t border-slate-100 pt-6">
					<Axis
						title="Chiqish"
						subtitle="Bu yerda taxmin yo'q — audio va matn yig'indisi jami chiqishga teng"
						total={outputTotal}
						segments={[
							{
								label: "Audio",
								value: voice.outputAudioTokens,
								color: CHART_COLORS.series,
								hint: "model gapirgan ovoz — odatda eng qimmat qator",
							},
							{
								label: "Matn",
								value: voice.outputTextTokens,
								color: CHART_COLORS.neutral,
								hint: "vosita chaqiruvlari va transkript",
							},
						]}
					/>
				</div>
			</div>

			{voice.estimated && (
				<div className="mt-6 border-t border-slate-100 pt-4 text-[11px] font-medium text-slate-400">
					Keshdan olingan tokenlarning matn/audio nisbatini provayder bermaydi — u yuqoridagi
					audio/matn ulushi asosida taqsimlangan. Shu sababli kirish narxi taxminiy, chiqish narxi
					esa aniq.
				</div>
			)}
		</Card>
	);
}
