import { FilterOutlined } from "@ant-design/icons";
import { Card, Checkbox, Select } from "antd";
import { OPERATOR_STATUS_LABELS } from "@/shared/utils/labels";
import type { OperatorStatus } from "../types";

interface Props {
	onFilterChange: (filters: {
		status?: OperatorStatus | undefined;
		includeDeleted?: boolean;
	}) => void;
}

/**
 * Operatorlar filtri.
 *
 * `GET /operator-profiles` faqat `includeDeleted`, `page` va `limit` ni qabul
 * qiladi, shuning uchun bu yerdagi qidiruv maydoni olib tashlandi (u hech
 * qanday so'rovga tushmagan edi). Holat bo'yicha filtr esa serverga emas,
 * sahifadagi ro'yxatga qo'llanadi — shu sababli u ochiq-oydin "shu sahifada"
 * deb belgilangan.
 */
export function OperatorFilters({ onFilterChange }: Props) {
	return (
		<Card className="mb-6 overflow-hidden rounded-2xl border-none bg-white/60 shadow-sm backdrop-blur-md">
			<div className="flex flex-wrap items-center gap-4">
				<Select
					placeholder="Holat bo'yicha (shu sahifada)"
					className="custom-select h-11 w-60"
					allowClear
					suffixIcon={<FilterOutlined />}
					options={[
						{ label: OPERATOR_STATUS_LABELS.online, value: "online" },
						{ label: OPERATOR_STATUS_LABELS.offline, value: "offline" },
						{ label: OPERATOR_STATUS_LABELS.pause, value: "pause" },
						{ label: OPERATOR_STATUS_LABELS.busy, value: "busy" },
					]}
					onChange={(status: OperatorStatus | undefined) => onFilterChange({ status })}
				/>

				<Checkbox
					onChange={(e) => onFilterChange({ includeDeleted: e.target.checked })}
					className="font-medium text-slate-600"
				>
					O'chirilganlarni ham ko'rsatish
				</Checkbox>
			</div>
		</Card>
	);
}
