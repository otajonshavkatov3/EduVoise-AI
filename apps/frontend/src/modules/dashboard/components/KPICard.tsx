import type React from "react";
import { NO_DATA_LABEL } from "../utils/format";

interface KPICardProps {
	title: string;
	/**
	 * Tayyor matn yoki son. `null` — ko'rsatkichni haqiqiy ma'lumotdan hisoblab
	 * bo'lmadi; bunda 0 emas, "ma'lumot yo'q" ko'rsatiladi.
	 */
	value: string | number | null;
	icon: React.ComponentType<{ className: string }>;
	/** Oldingi teng davrga nisbatan o'zgarish foizi. null bo'lsa belgi chizilmaydi. */
	trend?: number | null;
	suffix?: string;
	description?: string;
	/** true — o'sish yomon (masalan javobsiz qo'ng'iroqlar): ranglar teskari. */
	invertTrend?: boolean;
	isLoading?: boolean;
}

export function KPICard({
	title,
	value,
	icon: Icon,
	trend = null,
	suffix = "",
	description,
	invertTrend = false,
	isLoading = false,
}: KPICardProps) {
	const hasValue = value !== null;
	const hasTrend = trend !== null && trend !== undefined;
	const isUp = hasTrend && trend >= 0;
	// O'sish har doim "yaxshi" emas: javobsiz qo'ng'iroqning o'sishi qizil bo'lishi kerak.
	const isGood = invertTrend ? !isUp : isUp;

	return (
		<div className="group relative overflow-hidden rounded-2xl border border-slate-100 bg-white p-6 shadow-sm transition-all duration-300 hover:shadow-md">
			<div className="absolute -right-4 -top-4 h-24 w-24 rounded-full bg-slate-50 transition-colors duration-300 group-hover:bg-blue-50" />

			<div className="relative z-10">
				<div className="mb-4 flex items-center justify-between">
					<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-50 shadow-sm shadow-slate-100 transition-all duration-300 group-hover:bg-blue-600 group-hover:shadow-blue-200">
						<Icon className="h-6 w-6 text-slate-400 transition-colors duration-300 group-hover:text-white" />
					</div>
					{hasTrend && (
						<div
							className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
								isGood ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
							}`}
							title="Oldingi teng davrga nisbatan"
						>
							{isUp ? "↑" : "↓"} {Math.abs(trend).toFixed(1).replace(".", ",")}%
						</div>
					)}
				</div>

				<div>
					<p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">{title}</p>
					<div className="flex items-baseline gap-1">
						{isLoading && (
							<span className="inline-block h-7 w-16 animate-pulse rounded-md bg-slate-100" />
						)}
						{!isLoading && hasValue && (
							<h3 className="text-2xl font-extrabold text-slate-900">
								{value}
								{suffix && <span className="ml-0.5 text-lg font-semibold">{suffix}</span>}
							</h3>
						)}
						{!(isLoading || hasValue) && (
							<span className="text-sm font-bold text-slate-400">{NO_DATA_LABEL}</span>
						)}
					</div>
					{description && (
						<p className="mt-1 text-[11px] font-medium text-slate-400">{description}</p>
					)}
				</div>
			</div>
		</div>
	);
}
