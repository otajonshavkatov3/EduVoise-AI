import { Card, DatePicker, Select, Space } from "antd";
import type { AuditFilters as IAuditFilters } from "../types";
import { AUDIT_ACTION_OPTIONS } from "../utils/labels";

const { RangePicker } = DatePicker;

interface Props {
	onFiltersChange: (filters: Partial<IAuditFilters>) => void;
}

export function AuditFilters({ onFiltersChange }: Props) {
	return (
		<Card className="mb-6 border-none shadow-sm rounded-2xl overflow-hidden bg-white/60 backdrop-blur-md">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<Space wrap size="middle" className="flex-1">
					{/* Ro'yxat, matn maydoni emas: harakat bazada texnik kalit bo'lib
					    saqlanadi ("auth.login"), foydalanuvchi esa faqat o'zbekcha nomini
					    ko'radi — yozib qidirish uchun kalitni bilish kerak bo'lardi. */}
					<Select
						placeholder="Harakat turi"
						className="custom-select h-11 w-[280px]"
						allowClear
						showSearch
						optionFilterProp="label"
						options={AUDIT_ACTION_OPTIONS}
						onChange={(action: string | undefined) => onFiltersChange({ action, page: 1 })}
					/>

					<RangePicker
						className="h-11 rounded-xl border-slate-200"
						placeholder={["Boshlanish", "Tugash"]}
						onChange={(dates) => {
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
				</Space>
			</div>
		</Card>
	);
}
