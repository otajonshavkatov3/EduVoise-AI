import { ApiOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Card, Empty, Space, Tag, Typography } from "antd";
import { Link } from "react-router-dom";
import { aiSessionStatusConfig, languageLabel } from "@/modules/ai-assistant/utils/labels";
import { formatTokens, NO_DATA, providerLabel } from "@/modules/ai-costs/utils/format";
import { formatDateTime } from "@/shared/utils/datetime";
import type { CallFullSession } from "../../types/callFull";
import { Fact } from "./FactGrid";

const { Text } = Typography;

/** Qayd etilmagan hisoblagich — "ma'lumot yo'q", 0 emas. */
function tokenValue(value: number | null): string {
	return value === null ? NO_DATA : formatTokens(value);
}

function TokenRow({ label, value }: { label: string; value: string }) {
	const isEmpty = value === NO_DATA;

	return (
		<div className="flex items-baseline justify-between gap-3 border-b border-slate-50 py-2 last:border-b-0">
			<div className="text-xs font-bold text-slate-600">{label}</div>
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

/** durationMs -> "4 daq 14 s". */
function formatMs(ms: number | null): string | undefined {
	if (ms === null || !Number.isFinite(ms) || ms <= 0) {
		return undefined;
	}
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes === 0 ? `${seconds} s` : `${minutes} daq ${seconds} s`;
}

/** O'lchangan nol — "0 s". Bu maydon nullable emas, demak nol ham natija. */
function audioSeconds(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/**
 * Qo'ng'iroqqa javob bergan AI sessiyasi va uning token sarfi.
 *
 * Tokenlar hamma rolga ko'rinadi — sarf operatsion ko'rsatkich, pul esa alohida
 * kartada va faqat supervisor/admin uchun.
 */
export function CallSessionCard({ session }: { session: CallFullSession | null }) {
	if (!session) {
		return (
			<Card
				className="overflow-hidden rounded-2xl border-none shadow-sm"
				title={
					<Space size="small">
						<ThunderboltOutlined className="text-amber-500" />
						<span className="text-xs font-black uppercase tracking-widest">AI sessiyasi</span>
					</Space>
				}
			>
				<Empty
					className="py-6"
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={
						<div className="space-y-1">
							<div className="text-sm font-bold text-slate-500">AI sessiyasi ochilmagan</div>
							<div className="text-xs font-medium text-slate-400">
								Qo'ng'iroqni AI emas, odam yoki zaxira IVR o'tkazgan — token ham, model xarajati ham
								yo'q.
							</div>
						</div>
					}
				/>
			</Card>
		);
	}

	const status = aiSessionStatusConfig[session.status];
	const tokens = session.tokens;

	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<Space size="small">
					<ThunderboltOutlined className="text-amber-500" />
					<span className="text-xs font-black uppercase tracking-widest">AI sessiyasi</span>
				</Space>
			}
			extra={
				<Tag color={status.color} className="m-0 rounded-lg border-none text-[10px] font-bold">
					{status.label}
				</Tag>
			}
		>
			{session.errorMessage && (
				<Alert
					type="error"
					showIcon
					className="mb-4 rounded-xl"
					message="Sessiya xatosi"
					description={<span className="text-slate-600">{session.errorMessage}</span>}
				/>
			)}

			<div className="grid grid-cols-2 gap-x-6 gap-y-5">
				<Fact label="Provayder" value={providerLabel(session.provider)} />
				<Fact label="Model" value={session.model} />
				<Fact label="Ovoz" value={session.voice} />
				<Fact label="Til" value={session.language ? languageLabel(session.language) : undefined} />
				<Fact label="Davomiyligi" value={formatMs(session.durationMs)} />
				<Fact
					label="To'xtatishlar"
					value={session.interruptions}
					hint="Mijoz AI gapini bo'lgan holatlar"
				/>
				<Fact label="Kiruvchi audio" value={audioSeconds(session.inputAudioMs)} />
				<Fact label="Chiquvchi audio" value={audioSeconds(session.outputAudioMs)} />
				<Fact label="Javoblar soni" value={session.responseTurns ?? undefined} />
				<Fact label="Kanal" value={session.channelId} />
				<Fact label="Boshlandi" value={formatDateTime(session.startedAt)} />
				<Fact label="Tugadi" value={formatDateTime(session.endedAt)} />
			</div>

			<div className="mt-6 border-t border-slate-100 pt-4">
				<div className="mb-1 text-[10px] font-black uppercase tracking-widest text-slate-500">
					Token sarfi
				</div>
				<TokenRow label="Kirish — jami" value={tokenValue(tokens.promptTokens)} />
				<TokenRow label="Kirish — keshdan" value={tokenValue(tokens.cachedPromptTokens)} />
				<TokenRow label="Kirish — audio" value={tokenValue(tokens.inputAudioTokens)} />
				<TokenRow label="Kirish — matn" value={tokenValue(tokens.inputTextTokens)} />
				<TokenRow label="Chiqish — jami" value={tokenValue(tokens.completionTokens)} />
				<TokenRow label="Chiqish — audio" value={tokenValue(tokens.outputAudioTokens)} />
				<TokenRow label="Chiqish — matn" value={tokenValue(tokens.outputTextTokens)} />
				<TokenRow label="Transkripsiya — audio" value={tokenValue(tokens.transcribeAudioTokens)} />
				<TokenRow label="Transkripsiya — matn" value={tokenValue(tokens.transcribeTextTokens)} />
				{tokens.transcribeModel && (
					<Text className="mt-2 block font-mono text-[10px] text-slate-400">
						Transkripsiya modeli: {tokens.transcribeModel}
					</Text>
				)}
			</div>

			<Link
				to={`/ai-assistant/sessions/${session.id}`}
				className="mt-4 inline-flex items-center gap-2 text-[11px] font-bold text-blue-600"
			>
				<ApiOutlined />
				Sessiya kartasini ochish
			</Link>
		</Card>
	);
}
