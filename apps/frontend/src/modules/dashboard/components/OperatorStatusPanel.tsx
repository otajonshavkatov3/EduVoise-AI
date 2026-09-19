import { Card, Empty, Spin } from "antd";
import type { DashboardOperatorStatuses, OperatorStatus } from "../types";
import { refetchOpacity } from "../utils/chartTheme";
import { shareOf } from "../utils/format";

interface OperatorStatusPanelProps {
	data?: DashboardOperatorStatuses;
	isLoading: boolean;
	isFetching: boolean;
}

interface StatusRow {
	key: OperatorStatus;
	label: string;
	hint: string;
	/** Status ranglari — identifikator emas, holat ma'nosini bildiradi. */
	barClass: string;
	dotClass: string;
}

const STATUS_ROWS: StatusRow[] = [
	{
		key: "online",
		label: "Onlayn",
		hint: "Qo'ng'iroq qabul qilishga tayyor",
		barClass: "bg-emerald-500",
		dotClass: "bg-emerald-500",
	},
	{
		key: "busy",
		label: "Band",
		hint: "Hozir qo'ng'iroqda",
		barClass: "bg-blue-600",
		dotClass: "bg-blue-600",
	},
	{
		key: "pause",
		label: "Tanaffus",
		hint: "Vaqtincha qo'ng'iroq qabul qilmaydi",
		barClass: "bg-amber-400",
		dotClass: "bg-amber-400",
	},
	{
		key: "offline",
		label: "Oflayn",
		hint: "Tizimga ulanmagan",
		barClass: "bg-slate-300",
		dotClass: "bg-slate-300",
	},
];

/** TZ 3.1: faol operatorlar va ularning status kesimi. */
export function OperatorStatusPanel({ data, isLoading, isFetching }: OperatorStatusPanelProps) {
	const total = data?.total ?? 0;

	return (
		<Card
			className="h-full border-slate-100 shadow-sm"
			styles={{ body: { padding: 24 } }}
			title={
				<div className="flex flex-col gap-1 py-4">
					<span className="text-lg font-extrabold tracking-tight text-slate-900">
						Operatorlar holati
					</span>
					<span className="text-xs font-medium text-slate-500">
						Hozirgi status kesimi (real vaqtdagi holat)
					</span>
				</div>
			}
		>
			{isLoading && (
				<div className="flex min-h-[240px] items-center justify-center" aria-busy="true">
					<Spin size="large" />
				</div>
			)}

			{!isLoading && total === 0 && (
				<div className="flex min-h-[240px] items-center justify-center">
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description={
							<div className="text-center">
								<div className="font-bold text-slate-500">Operator profili yo'q</div>
								<div className="mt-1 text-xs text-slate-400">
									Operatorlar bo'limida profil yaratilgach ko'rinadi
								</div>
							</div>
						}
					/>
				</div>
			)}

			{!isLoading && data && total > 0 && (
				<div className={refetchOpacity(isFetching)}>
					<div className="mb-6 flex items-end justify-between">
						<div>
							<div className="text-3xl font-black text-slate-900">{data.active}</div>
							<div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
								Faol operator
							</div>
						</div>
						<div className="text-right">
							<div className="text-sm font-bold text-slate-500">{total} ta</div>
							<div className="text-[10px] font-medium text-slate-400">jami profil</div>
						</div>
					</div>

					<div className="space-y-4">
						{STATUS_ROWS.map((row) => {
							const value = data[row.key];

							return (
								<div key={row.key}>
									<div className="mb-1.5 flex items-center justify-between">
										<div className="flex items-center gap-2">
											<span className={`h-2 w-2 rounded-full ${row.dotClass}`} />
											<span className="text-xs font-bold text-slate-700">{row.label}</span>
										</div>
										<span className="text-xs font-bold tabular-nums text-slate-900">
											{value} · {shareOf(value, total)}
										</span>
									</div>
									<div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
										<div
											className={`h-full rounded-full ${row.barClass}`}
											style={{ width: shareOf(value, total) }}
										/>
									</div>
									<div className="mt-1 text-[10px] font-medium text-slate-400">{row.hint}</div>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</Card>
	);
}
