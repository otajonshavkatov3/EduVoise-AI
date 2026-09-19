import { Clock, Phone, PhoneIncoming, PhoneMissed, Timer, Users } from "lucide-react";
import type { DashboardOverview, DashboardPeriod } from "../types";
import { formatDuration, formatPercent, PERIOD_PHRASES, percentChange } from "../utils/format";
import { KPICard } from "./KPICard";

interface DashboardKpiRowProps {
	overview?: DashboardOverview;
	period: DashboardPeriod;
	isLoading: boolean;
}

/** null bo'lsa KPICard "ma'lumot yo'q" ko'rsatadi — 0 yozilmaydi. */
function durationOrNull(seconds: number | null | undefined): string | null {
	return seconds === null || seconds === undefined ? null : formatDuration(seconds);
}

/**
 * TZ 3.1 KPI qatori. Har bir son /dashboard/overview'dan keladi; trend esa
 * teng uzunlikdagi oldingi davrga nisbatan hisoblanadi (oldingi davr 0 bo'lsa
 * trend ko'rsatilmaydi).
 */
export function DashboardKpiRow({ overview, period, isLoading }: DashboardKpiRowProps) {
	const current = overview?.current;
	const previous = overview?.previous;
	const operators = overview?.operators;

	return (
		<div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
			<KPICard
				title="Jami qo'ng'iroqlar"
				value={current?.total ?? null}
				icon={Phone}
				trend={percentChange(current?.total, previous?.total)}
				isLoading={isLoading}
				description={
					current
						? `Kiruvchi ${current.inbound} · chiquvchi ${current.outbound}`
						: `Qo'ng'iroqlar soni (${PERIOD_PHRASES[period]})`
				}
			/>
			<KPICard
				title="Javob berilgan"
				value={current?.answered ?? null}
				icon={PhoneIncoming}
				trend={percentChange(current?.answered, previous?.answered)}
				isLoading={isLoading}
				description={
					current
						? `Javob berish darajasi ${formatPercent(current.answerRate)}`
						: "Muvaffaqiyatli bog'lanishlar"
				}
			/>
			<KPICard
				title="Javobsiz"
				value={current?.unanswered ?? null}
				icon={PhoneMissed}
				trend={percentChange(current?.unanswered, previous?.unanswered)}
				invertTrend
				isLoading={isLoading}
				description={
					current
						? `O'tkazib yuborilgan ${current.missed} · tashlab ketilgan ${current.abandoned}`
						: "Javobsiz qolgan murojaatlar"
				}
			/>
			<KPICard
				title="O'rtacha muloqot"
				value={durationOrNull(current?.avgTalkTimeSec)}
				icon={Clock}
				isLoading={isLoading}
				description={
					current && current.talkTimeSampleSize > 0
						? `${current.talkTimeSampleSize} ta yakunlangan qo'ng'iroq bo'yicha`
						: "Yakunlangan qo'ng'iroq yo'q"
				}
			/>
			<KPICard
				title="Navbatda kutish"
				value={durationOrNull(current?.avgWaitingTimeSec)}
				icon={Timer}
				trend={percentChange(current?.avgWaitingTimeSec, previous?.avgWaitingTimeSec)}
				invertTrend
				isLoading={isLoading}
				description={
					current && current.waitingTimeSampleSize > 0
						? `${current.waitingTimeSampleSize} ta javob berilgan qo'ng'iroq bo'yicha`
						: "Javob berish vaqti yozilgan qo'ng'iroq yo'q"
				}
			/>
			<KPICard
				title="Faol operatorlar"
				value={operators?.active ?? null}
				icon={Users}
				isLoading={isLoading}
				description={
					operators
						? `${operators.total} ta profildan onlayn yoki suhbatda`
						: "Hozirda faol operatorlar"
				}
			/>
		</div>
	);
}
