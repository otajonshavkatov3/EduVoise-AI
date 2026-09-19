import { ReloadOutlined } from "@ant-design/icons";
import { Button, Card, DatePicker, Input, Select, Space, Tooltip, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useOperators } from "@/modules/operators/hooks/useOperators";
import type { CallDirection, CallStatus, ReportKind, TicketPriority, TicketStatus } from "../types";
import {
	CALL_DIRECTION_LABELS,
	CALL_STATUS_LABELS,
	TICKET_PRIORITY_LABELS,
	TICKET_STATUS_LABELS,
} from "../utils/format";

const { RangePicker } = DatePicker;
const { Text } = Typography;

/** Backend bilan bir xil chegara — foydalanuvchi 422 ni kutmasdan biladi. */
export const MAX_RANGE_DAYS = 366;

export interface ReportFilterValues {
	from: string;
	to: string;
	operatorId?: string;
	status?: string;
	direction?: CallDirection;
	priority?: TicketPriority;
	category?: string;
}

interface Props {
	kind: ReportKind;
	values: ReportFilterValues;
	onChange: (patch: Partial<ReportFilterValues>) => void;
	onReset: () => void;
	onRefresh: () => void;
	isFetching: boolean;
	/** Oraliq chegaradan oshganda ko'rsatiladigan ogohlantirish. */
	onRangeRejected: (days: number) => void;
}

const callStatusOptions = (Object.keys(CALL_STATUS_LABELS) as CallStatus[]).map((status) => ({
	value: status,
	label: CALL_STATUS_LABELS[status],
}));

const ticketStatusOptions = (Object.keys(TICKET_STATUS_LABELS) as TicketStatus[]).map((status) => ({
	value: status,
	label: TICKET_STATUS_LABELS[status],
}));

const priorityOptions = (Object.keys(TICKET_PRIORITY_LABELS) as TicketPriority[]).map(
	(priority) => ({
		value: priority,
		label: TICKET_PRIORITY_LABELS[priority],
	})
);

const directionOptions = (Object.keys(CALL_DIRECTION_LABELS) as CallDirection[]).map(
	(direction) => ({
		value: direction,
		label: CALL_DIRECTION_LABELS[direction],
	})
);

export function ReportFilters({
	kind,
	values,
	onChange,
	onReset,
	onRefresh,
	isFetching,
	onRangeRejected,
}: Props) {
	const { data: operatorsData, isLoading: isLoadingOperators } = useOperators({ limit: 100 });

	const operatorOptions = (operatorsData?.data.items ?? []).map((operator) => ({
		value: operator.id,
		label: `${operator.extension} — ${operator.user?.phone ?? "Operator"}`,
	}));

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

					<Select<string>
						allowClear
						showSearch
						optionFilterProp="label"
						placeholder="Operator"
						loading={isLoadingOperators}
						options={operatorOptions}
						value={values.operatorId}
						onChange={(value) => onChange({ operatorId: value })}
						className="custom-select h-12 w-[240px]"
					/>

					{kind === "calls" && (
						<Select<string>
							allowClear
							placeholder="Qo'ng'iroq holati"
							options={callStatusOptions}
							value={values.status}
							onChange={(value) => onChange({ status: value })}
							className="custom-select h-12 w-[200px]"
						/>
					)}

					{kind === "tickets" && (
						<Select<string>
							allowClear
							placeholder="Murojaat holati"
							options={ticketStatusOptions}
							value={values.status}
							onChange={(value) => onChange({ status: value })}
							className="custom-select h-12 w-[200px]"
						/>
					)}

					{kind === "tickets" && (
						<Select<TicketPriority>
							allowClear
							placeholder="Muhimlik"
							options={priorityOptions}
							value={values.priority}
							onChange={(value) => onChange({ priority: value })}
							className="custom-select h-12 w-[160px]"
						/>
					)}

					{kind === "tickets" && (
						<Input
							allowClear
							placeholder="Kategoriya"
							value={values.category ?? ""}
							onChange={(event) => onChange({ category: event.target.value })}
							className="h-12 w-[200px] rounded-xl border-slate-200 bg-slate-50"
						/>
					)}

					{kind !== "tickets" && (
						<Select<CallDirection>
							allowClear
							placeholder="Yo'nalish"
							options={directionOptions}
							value={values.direction}
							onChange={(value) => onChange({ direction: value })}
							className="custom-select h-12 w-[170px]"
						/>
					)}
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
