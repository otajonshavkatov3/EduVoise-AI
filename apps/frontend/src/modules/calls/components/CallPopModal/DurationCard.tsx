import { ClockCircleOutlined, WifiOutlined } from "@ant-design/icons";
import { Tag, Tooltip, Typography } from "antd";
import { useEffect, useState } from "react";
import { EMPTY_VALUE, formatTime as formatClock } from "@/shared/utils/datetime";
import type { CallEndReason } from "../../store/callPop.store";
import { isActive, isEnded, isMissed } from "../../utils/callStatus";

const { Text } = Typography;

interface DurationCardProps {
	duration: number;
	status: string;
	direction?: "inbound" | "outbound";
	formatTime: (seconds: number) => string;
	networkQuality: { jitter: number; rtt: number } | null;
	endReason?: CallEndReason;
	endedAt?: string;
	/** Panel avtomatik yopilishiga qolgan sekundlar; `null` — sanoq yo'q. */
	dismissInSeconds?: number | null;
}

export function DurationCard({
	duration,
	status,
	direction,
	formatTime,
	networkQuality,
	endReason,
	endedAt,
	dismissInSeconds,
}: DurationCardProps) {
	const [waitTime, setWaitTime] = useState(0);

	const ended = isEnded(status);
	const active = !ended && isActive(status);
	// Qolgani — jiringlash/bog'lanish oynasi. Noma'lum holat ham shu yerga
	// tushadi: serverdan kelgan ramkada `status` bo'lmasligi mumkin, jonli
	// qo'ng'iroqni "tugagan" qilib ko'rsatishdan esa bu xavfsizroq.
	const ringing = !(ended || active);
	// Qizil "o'tkazib yuborildi" faqat operator qo'ng'iroqni HAQIQATAN o'tkazib
	// yuborganda. Chiquvchi qo'ng'iroqni uzoq tomon rad etgani ham, operatorning
	// o'zi RAD ETISH bosgani ham o'tkazib yuborish emas — ikkinchisida operatorga
	// o'zi rad etgan qo'ng'iroqni "o'tkazib yubordingiz" deb ko'rsatilardi.
	const missedInbound =
		ended &&
		isMissed(status) &&
		direction === "inbound" &&
		(endReason === undefined || endReason === "noAnswer");

	useEffect(() => {
		let interval: ReturnType<typeof setInterval>;
		if (ringing && direction === "inbound") {
			interval = setInterval(() => setWaitTime((v) => v + 1), 1000);
		} else {
			setWaitTime(0);
		}
		return () => clearInterval(interval);
	}, [ringing, direction]);

	const bgClass = cardBgClass({ ringing, active, missedInbound });
	const timeClass = timeColorClass({ ended, missedInbound });

	const { statusTag, tagColor } = getStatusTag({
		ringing,
		active,
		missedInbound,
		direction,
		endReason,
	});
	const isPoorQuality =
		networkQuality && (networkQuality.jitter > 0.05 || networkQuality.rtt > 0.4);

	return (
		<div
			className={`rounded-[24px] p-4 text-center mb-4 border-2 shrink-0 transition-all duration-500 shadow-sm ${bgClass}`}
		>
			<DurationHeader
				ringing={ringing}
				direction={direction}
				active={active}
				networkQuality={networkQuality}
				isPoorQuality={isPoorQuality}
			/>

			<div className="flex items-center justify-center h-10 mb-2">
				{ringing ? (
					<RingingDisplay direction={direction} waitTime={waitTime} />
				) : (
					<div
						className={`text-3xl font-black tracking-tighter transition-all duration-300 ${timeClass} [font-variant-numeric:tabular-nums]`}
					>
						{formatTime(duration)}
					</div>
				)}
			</div>

			<Tag
				color={tagColor}
				className="rounded-xl px-6 py-1.5 border-none font-black text-[10px] uppercase bg-opacity-15 shadow-sm transition-all"
			>
				{statusTag}
			</Tag>

			{ended && <EndedFooter endedAt={endedAt} dismissInSeconds={dismissInSeconds} />}
		</div>
	);
}

// ─── Sub-components ────────────────────────────────────────────────

function DurationHeader({
	ringing,
	direction,
	active,
	networkQuality,
	isPoorQuality,
}: {
	ringing: boolean;
	direction?: string;
	active: boolean;
	networkQuality: { jitter: number; rtt: number } | null;
	isPoorQuality: boolean | null;
}) {
	return (
		<div className="flex items-center justify-between px-2 mb-2">
			<div className="flex items-center gap-1.5 text-slate-400">
				<ClockCircleOutlined className="text-[10px]" />
				<Text className="text-[9px] font-black uppercase tracking-wider text-slate-400">
					{ringing ? (direction === "inbound" ? "Kutish" : "Bog'lanish") : "Davomiyligi"}
				</Text>
			</div>

			{active && <NetworkIndicator networkQuality={networkQuality} isPoorQuality={isPoorQuality} />}
		</div>
	);
}

function NetworkIndicator({
	networkQuality,
	isPoorQuality,
}: {
	networkQuality: { jitter: number; rtt: number } | null;
	isPoorQuality: boolean | null;
}) {
	return (
		<div className="flex items-center gap-2">
			<Tooltip
				title={
					networkQuality
						? `Kechikish: ${Math.round(networkQuality.rtt * 1000)} ms, tebranish: ${networkQuality.jitter.toFixed(3)}`
						: "Sifat o'lchanmoqda..."
				}
			>
				<div
					className={`flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[8px] font-black uppercase tracking-tighter ${
						isPoorQuality
							? "bg-red-50 text-red-500 border-red-100 animate-pulse"
							: "bg-emerald-50 text-emerald-600 border-emerald-100"
					}`}
				>
					<WifiOutlined className={isPoorQuality ? "animate-bounce" : ""} />
					{isPoorQuality ? "Zaif ulanish" : "Sifatli aloqa"}
				</div>
			</Tooltip>
			<div className="flex items-center gap-1 bg-red-50 px-2 py-0.5 rounded-lg border border-red-100 shadow-xs">
				<div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
				<Text className="text-[8px] font-black text-red-600 uppercase tracking-tighter">REC</Text>
			</div>
		</div>
	);
}

function RingingDisplay({ direction, waitTime }: { direction?: string; waitTime: number }) {
	return (
		<div className="flex flex-col items-center">
			<div className="text-2xl font-black text-blue-500 animate-pulse tracking-tight">
				{direction === "outbound" ? "Bog'lanilmoqda..." : "Kiruvchi..."}
			</div>
			{direction === "inbound" && (
				<Text className="text-[10px] font-bold text-blue-400 -mt-1">Kutish: {waitTime}s</Text>
			)}
		</div>
	);
}

/**
 * Tugash vaqti va avtomatik yopilish sanog'i. Jonli qo'ng'iroqlar doskasidagi
 * tugagan qator bilan bir xil ko'rinish (`LiveCallCard` — slate-400, 11px).
 */
function EndedFooter({
	endedAt,
	dismissInSeconds,
}: {
	endedAt?: string;
	dismissInSeconds?: number | null;
}) {
	// Noto'g'ri sana kelsa vaqt umuman ko'rsatilmaydi ("Tugadi · —" o'rniga "Tugadi").
	const clock = endedAt ? formatClock(endedAt) : EMPTY_VALUE;
	const timeLabel = clock === EMPTY_VALUE ? null : clock;

	return (
		<div className="mt-3 text-[11px] font-semibold text-slate-600">
			{timeLabel ? `Tugadi · ${timeLabel}` : "Tugadi"}
			{dismissInSeconds !== null && dismissInSeconds !== undefined && dismissInSeconds > 0 && (
				<span className="ml-1 text-[10px] font-black uppercase tracking-tighter">
					· Panel {dismissInSeconds} s dan keyin yopiladi
				</span>
			)}
		</div>
	);
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Tugash sababining panel matni. */
const END_REASON_LABELS: Record<CallEndReason, string> = {
	completed: "Qo'ng'iroq tugallandi",
	cancelled: "Bekor qilindi",
	rejected: "Rad etildi",
	busy: "Abonent band",
	noAnswer: "Javob bo'lmadi",
	failed: "Ulanmadi",
};

/**
 * Teg rangi — loyihaning mavjud status palitrasi bo'yicha.
 *
 * `completed -> cyan` va `missed -> red` aynan `callStatusConfig`dan
 * (CallStatusBadge), band holati esa operator teglaridagi `error`dan olingan.
 * Ilgari barcha sabablar bitta kulrang "default" tegi bilan chiqardi: muvaffaqiyatli
 * yakun, rad etish, band liniya va ulanmagan qo'ng'iroq bir xil ko'rinib, teg
 * hech qanday ma'lumot bermay qolgan edi.
 */
const END_REASON_COLORS: Record<CallEndReason, string> = {
	completed: "cyan",
	cancelled: "default",
	rejected: "orange",
	busy: "error",
	noAnswer: "warning",
	failed: "error",
};

function cardBgClass({
	ringing,
	active,
	missedInbound,
}: {
	ringing: boolean;
	active: boolean;
	missedInbound: boolean;
}): string {
	if (ringing) {
		return "bg-blue-50/50 border-blue-100";
	}
	if (missedInbound) {
		return "bg-red-50/50 border-red-100";
	}
	if (active) {
		return "bg-emerald-50/50 border-emerald-100";
	}
	// slate-100/200, slate-50 emas: panel tanasi allaqachon #ffffff -> #f9fafb
	// gradienti, unda slate-50 kartochka bo'lib ko'rinmay qoladi — jonli va
	// jiringlayotgan holatlar ajralib turgani holda tugagan holat ko'zga
	// tashlanmasdi, ya'ni eng muhim signal eng zaif ko'rinardi.
	return "bg-slate-100 border-slate-200";
}

/**
 * Tugagan qo'ng'iroqda raqam so'nadi, lekin o'qilishi shart.
 *
 * slate-400 emas: u jonli doskada butun kartochkasi `opacity-70` bo'lgan uzun
 * ro'yxatning bitta qatori uchun mos, bu yerda esa panelning asosiy raqami —
 * slate-100 fonda kontrasti 2.45:1 bo'lib, o'qilmas darajada edi.
 */
function timeColorClass({
	ended,
	missedInbound,
}: {
	ended: boolean;
	missedInbound: boolean;
}): string {
	if (missedInbound) {
		return "text-red-500";
	}
	if (ended) {
		return "text-slate-600";
	}
	return "text-slate-900";
}

function getStatusTag({
	ringing,
	active,
	missedInbound,
	direction,
	endReason,
}: {
	ringing: boolean;
	active: boolean;
	missedInbound: boolean;
	direction?: string;
	endReason?: CallEndReason;
}): { statusTag: string; tagColor: string } {
	if (ringing) {
		return {
			statusTag: direction === "outbound" ? "Qo'ng'iroq qilinmoqda..." : "Jiringlamoqda...",
			tagColor: "processing",
		};
	}
	if (active) {
		return { statusTag: "Aktiv bog'lanish", tagColor: "success" };
	}
	if (missedInbound) {
		return { statusTag: "O'tkazib yuborildi", tagColor: "error" };
	}

	const reason = endReason ?? "completed";

	return { statusTag: END_REASON_LABELS[reason], tagColor: END_REASON_COLORS[reason] };
}
