import { SearchOutlined } from "@ant-design/icons";
import { Card, Input } from "antd";

interface Props {
	onSearch: (q: string) => void;
}

export function ContactFilters({ onSearch }: Props) {
	return (
		<Card className="mb-6 border-none shadow-sm rounded-2xl overflow-hidden bg-white/60 backdrop-blur-md">
			<div className="flex flex-wrap items-center gap-4">
				<div className="flex-1 min-w-[280px]">
					<Input
						placeholder="Ism, telefon yoki manzil bo'yicha qidirish..."
						prefix={<SearchOutlined className="text-slate-400" />}
						className="h-11 rounded-xl bg-slate-50 border-slate-200"
						onChange={(e) => onSearch(e.target.value)}
					/>
				</div>
			</div>
		</Card>
	);
}
