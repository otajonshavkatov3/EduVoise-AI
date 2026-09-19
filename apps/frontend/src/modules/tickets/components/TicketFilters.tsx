import { SearchOutlined } from "@ant-design/icons";
import { Card, Input, Select } from "antd";
import { useDebouncedCallback } from "@/shared/hooks/useDebouncedCallback";
import { priorityConfig } from "./TicketPriorityTag";
import { statusConfig } from "./TicketStatusBadge";

export interface TicketFilterPatch {
	status?: string | undefined;
	priority?: string | undefined;
	q?: string | undefined;
}

interface Props {
	/**
	 * Faqat o'zgargan maydon yuboriladi.
	 *
	 * Avval har bir boshqaruv qolgan ikkitasiga `undefined` berardi, ya'ni holatni
	 * tanlash prioritetni o'chirib yuborardi va filtrlarni birga ishlatib
	 * bo'lmasdi.
	 */
	onFilterChange: (patch: TicketFilterPatch) => void;
}

export function TicketFilters({ onFilterChange }: Props) {
	const onSearch = useDebouncedCallback((q: string | undefined) => onFilterChange({ q }));

	return (
		<Card className="mb-6 border-none shadow-sm rounded-2xl overflow-hidden bg-white/60 backdrop-blur-md">
			<div className="flex flex-wrap items-center gap-4">
				<div className="flex-1 min-w-[240px]">
					<Input
						placeholder="Mavzu bo'yicha qidirish..."
						prefix={<SearchOutlined className="text-slate-400" />}
						className="h-11 rounded-xl bg-slate-50 border-slate-200"
						allowClear
						onChange={(e) => onSearch(e.target.value || undefined)}
					/>
				</div>
				<Select
					placeholder="Holat"
					className="w-40 h-11"
					allowClear
					options={Object.entries(statusConfig).map(([val, cfg]) => ({
						label: cfg.label,
						value: val,
					}))}
					onChange={(status) => onFilterChange({ status })}
				/>
				<Select
					placeholder="Muhimlik"
					className="w-40 h-11"
					allowClear
					options={Object.entries(priorityConfig).map(([val, cfg]) => ({
						label: cfg.label,
						value: val,
					}))}
					onChange={(priority) => onFilterChange({ priority })}
				/>
			</div>
		</Card>
	);
}
