import { ClearOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Card, DatePicker, Input, Select } from "antd";
import { type ComponentProps, useState } from "react";
import type { AiSessionStatus, AiSessionFilters as IAiSessionFilters } from "../types";
import { aiSessionStatusConfig } from "../utils/labels";

const { RangePicker } = DatePicker;

/** RangePicker o'z qiymat tipini beradi — dayjs ni alohida import qilish shart emas. */
type DateRangeValue = ComponentProps<typeof RangePicker>["value"];

interface Props {
	onFiltersChange: (filters: Partial<IAiSessionFilters>) => void;
	onReset: () => void;
}

const statusOptions = (Object.keys(aiSessionStatusConfig) as AiSessionStatus[]).map((status) => ({
	value: status,
	label: aiSessionStatusConfig[status].label,
}));

/**
 * Sessiya filtrlari.
 *
 * Uchala boshqaruv ham boshqariladigan (controlled) holatda: ilgari «Tozalash»
 * so'rovni tozalar, lekin Select va sanalar eski qiymatini ko'rsatib turardi —
 * jadval filtrsiz, UI esa filtr yoqilgandek ko'rinardi.
 */
export function SessionFilters({ onFiltersChange, onReset }: Props) {
	const [providerInput, setProviderInput] = useState("");
	const [status, setStatus] = useState<AiSessionStatus | undefined>(undefined);
	const [range, setRange] = useState<DateRangeValue>(null);

	const handleReset = () => {
		setProviderInput("");
		setStatus(undefined);
		setRange(null);
		onReset();
	};

	return (
		<Card className="mb-6 border-none shadow-sm rounded-2xl overflow-hidden bg-white/60 backdrop-blur-md">
			<div className="flex flex-wrap items-center gap-4">
				<Select
					allowClear
					value={status}
					placeholder="Holat"
					options={statusOptions}
					className="custom-select w-[180px]"
					onChange={(value: AiSessionStatus | undefined) => {
						setStatus(value);
						onFiltersChange({ status: value, page: 1 });
					}}
				/>

				<Input
					value={providerInput}
					placeholder="Provayder nomi"
					prefix={<SearchOutlined className="text-slate-400" />}
					className="h-12 w-[240px] rounded-xl bg-slate-50 border-slate-200"
					allowClear
					onChange={(event) => setProviderInput(event.target.value)}
					onPressEnter={() =>
						onFiltersChange({ provider: providerInput.trim() || undefined, page: 1 })
					}
					onBlur={() => onFiltersChange({ provider: providerInput.trim() || undefined, page: 1 })}
				/>

				<RangePicker
					showTime
					value={range}
					className="h-12 rounded-xl bg-slate-50 border-slate-200"
					onChange={(dates) => {
						setRange(dates);

						if (dates) {
							onFiltersChange({
								from: dates[0]?.toISOString(),
								to: dates[1]?.toISOString(),
								page: 1,
							});
						} else {
							onFiltersChange({ from: undefined, to: undefined, page: 1 });
						}
					}}
				/>

				<Button
					icon={<ClearOutlined />}
					onClick={handleReset}
					className="h-12 rounded-xl px-5 font-bold"
				>
					Tozalash
				</Button>
			</div>
		</Card>
	);
}
