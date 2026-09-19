import { FilterOutlined } from "@ant-design/icons";
import { Card, Select } from "antd";
import { ROLE_OPTIONS } from "@/shared/utils/labels";
import type { UserRole } from "../types";

interface Props {
	onFilterChange: (filters: { role: UserRole | undefined }) => void;
}

/**
 * Foydalanuvchilar filtri.
 *
 * Diqqat: bu yerda qidiruv maydoni yo'q. `GET /users` faqat `role`, `page` va
 * `limit` parametrlarini qabul qiladi — avvalgi qidiruv inputi hech qanday
 * so'rovga tushmay, faqat ishlayotgandek ko'rinardi. Backendga matnli qidiruv
 * qo'shilgandan keyin bu joyga input qaytariladi.
 */
export function UserFilters({ onFilterChange }: Props) {
	return (
		<Card className="mb-6 overflow-hidden rounded-2xl border-none bg-white/60 shadow-sm backdrop-blur-md">
			<div className="flex flex-wrap items-center gap-4">
				<Select
					placeholder="Rol bo'yicha filtr"
					className="custom-select h-11 w-52"
					allowClear
					suffixIcon={<FilterOutlined />}
					options={ROLE_OPTIONS}
					onChange={(role: UserRole | undefined) => onFilterChange({ role })}
				/>
			</div>
		</Card>
	);
}
