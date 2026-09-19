import { ReloadOutlined } from "@ant-design/icons";
import { Button, Card, DatePicker, Segmented, Select, Space, Tooltip, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import type { GroupBy } from "../types";
import { GROUP_BY_LABELS, providerLabel } from "../utils/format";

const { RangePicker } = DatePicker;
const { Text } = Typography;

/** Backend bilan bir xil chegara — foydalanuvchi 422 ni kutmasdan biladi. */
export const MAX_RANGE_DAYS = 366;

export interface CostFilterValues {
	from: string;
	to: string;
	groupBy: GroupBy;
	provider?: string;
}

interface Props {
	values: CostFilterValues;
	/** Oraliqda uchragan provayderlar — ro'yxat ma'lumotdan quriladi, qattiq yozilmaydi. */
	providers: string[];
	onChange: (patch: Partial<CostFilterValues>) => void;
	onReset: () => void;
	onRefresh: () => void;
	isFetching: boolean;
	onRangeRejected: (days: number) => void;
}

const groupByOptions = (Object.keys(GROUP_BY_LABELS) as GroupBy[]).map((key) => ({
	value: key,
	label: GROUP_BY_LABELS[key],
}));

export function CostFilters({
	values,
	providers,
	onChange,
	onReset,
	onRefresh,
	isFetching,
	onRangeRejected,
}: Props) {
	const handleRangeChange = (dates: [Dayjs | null, Dayjs | null] | null) => {
		const start = dates?.[0];
		const end = dates?.[1];

		if (!(start && end)) {
			return;
		}

		const days = Math.ceil(end.diff(start, "day", true));

		if (days > MAX_RANGE_DAYS) {
			onRangeRejected(days);

			return;
		}

		onChange({ from: start.toISOString(), to: end.toISOString() });
	};

	return (
		<Card className="mb-6 overflow-hidden rounded-2xl border-none bg-white/60 shadow-sm backdrop-blur-md">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<Space wrap size="middle" className="flex-1">
					<div className="flex flex-col gap-1">
						<Text className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
							Sana oralig'i (majburiy)
						</Text>
						<RangePicker
							showTime={{ format: "HH:mm" }}
							format="DD.MM.YYYY HH:mm"
							allowClear={false}
							value={[dayjs(values.from), dayjs(values.to)]}
							onChange={handleRangeChange}
							className="h-12 rounded-xl border-slate-200 bg-slate-50"
						/>
					</div>

					<div className="flex flex-col gap-1">
						<Text className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
							Guruhlash
						</Text>
						<Segmented<GroupBy>
							value={values.groupBy}
							options={groupByOptions}
							onChange={(value) => onChange({ groupBy: value })}
							className="h-12 items-center"
						/>
					</div>

					<div className="flex flex-col gap-1">
						<Text className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
							Provayder
						</Text>
						<Select<string>
							allowClear
							placeholder="Barchasi"
							options={providers.map((provider) => ({
								value: provider,
								label: providerLabel(provider),
							}))}
							value={values.provider}
							onChange={(value) => onChange({ provider: value })}
							className="custom-select h-12 w-[220px]"
						/>
					</div>
				</Space>

				<Space size="small">
					<Button onClick={onReset} className="h-12 rounded-xl font-bold">
						Tozalash
					</Button>
					<Tooltip title="Yangilash">
						<Button
							icon={<ReloadOutlined />}
							loading={isFetching}
							onClick={onRefresh}
							className="h-12 w-12 rounded-xl"
						/>
					</Tooltip>
				</Space>
			</div>
		</Card>
	);
}
