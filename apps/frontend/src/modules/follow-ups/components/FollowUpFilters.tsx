import { ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { Button, Card, DatePicker, Select, Space, Switch, Tooltip, Typography } from "antd";
import { useOperators } from "@/modules/operators/hooks/useOperators";
import type { FollowUpStatus, FollowUpFilters as IFollowUpFilters } from "../types";
import { FOLLOW_UP_STATUS_CONFIG, FOLLOW_UP_STATUS_ORDER } from "./FollowUpStatusTag";

const { RangePicker } = DatePicker;
const { Text } = Typography;

interface Props {
	filters: IFollowUpFilters;
	onFiltersChange: (filters: Partial<IFollowUpFilters>) => void;
	onReset: () => void;
	onRefresh: () => void;
	isFetching?: boolean;
	/** Kanban ko'rinishida status filtri ustunlar bilan takrorlanadi */
	showStatusFilter?: boolean;
}

export function FollowUpFilters({
	filters,
	onFiltersChange,
	onReset,
	onRefresh,
	isFetching,
	showStatusFilter = true,
}: Props) {
	const { data: operatorsData, isLoading: isLoadingOperators } = useOperators({ limit: 100 });

	const operatorOptions = (operatorsData?.data.items ?? []).map((operator) => ({
		value: operator.id,
		label: `${operator.extension} — ${operator.user?.phone ?? "Operator"}`,
	}));

	const statusOptions = FOLLOW_UP_STATUS_ORDER.map((status) => ({
		value: status,
		label: FOLLOW_UP_STATUS_CONFIG[status].label,
	}));

	return (
		<Card className="mb-6 overflow-hidden rounded-2xl border-none bg-white/60 shadow-sm backdrop-blur-md">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<Space wrap size="middle" className="flex-1">
					{showStatusFilter && (
						<Select<FollowUpStatus>
							allowClear
							placeholder="Holat"
							options={statusOptions}
							value={filters.status}
							onChange={(value) => onFiltersChange({ status: value, page: 1 })}
							className="custom-select h-12 w-[180px]"
						/>
					)}

					<Select<string>
						allowClear
						showSearch
						optionFilterProp="label"
						placeholder="Mas'ul xodim"
						loading={isLoadingOperators}
						options={operatorOptions}
						value={filters.assignedTo}
						onChange={(value) => onFiltersChange({ assignedTo: value, page: 1 })}
						className="custom-select h-12 w-[240px]"
					/>

					<RangePicker
						showTime
						className="h-12 rounded-xl border-slate-200 bg-slate-50"
						placeholder={["Muddat (dan)", "Muddat (gacha)"]}
						onChange={(dates) => {
							if (dates?.[0] && dates[1]) {
								onFiltersChange({
									dueFrom: dates[0].toISOString(),
									dueTo: dates[1].toISOString(),
									page: 1,
								});
							} else {
								onFiltersChange({ dueFrom: undefined, dueTo: undefined, page: 1 });
							}
						}}
					/>

					<Space size="small">
						<Switch
							size="small"
							checked={filters.overdue === "true"}
							onChange={(checked) =>
								onFiltersChange({ overdue: checked ? "true" : "false", page: 1 })
							}
						/>
						<Text className="flex items-center gap-1 text-[11px] font-bold text-slate-500">
							<WarningOutlined className="text-rose-500" />
							Faqat muddati o'tganlar
						</Text>
					</Space>

					<Select<"true" | "false">
						allowClear
						placeholder="Kim yaratdi"
						options={[
							{ value: "true", label: "AI yaratgan" },
							{ value: "false", label: "Qo'lda yaratilgan" },
						]}
						value={filters.createdBySystem}
						onChange={(value) => onFiltersChange({ createdBySystem: value, page: 1 })}
						className="custom-select h-12 w-[180px]"
					/>
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
