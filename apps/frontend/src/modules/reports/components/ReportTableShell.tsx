import { Card, Empty } from "antd";
import type { TablePaginationConfig } from "antd/es/table";
import type { ReactNode } from "react";
import type { PaginationMeta } from "../types";

/** Uch hisobot jadvali uchun bir xil karta, sahifalash va bo'sh holat. */
export function ReportCard({ children }: { children: ReactNode }) {
	return <Card className="overflow-hidden rounded-2xl border-none shadow-sm">{children}</Card>;
}

export function buildPagination(
	meta: PaginationMeta | undefined,
	onPageChange: (page: number, limit: number) => void
): TablePaginationConfig {
	return {
		current: meta?.page ?? 1,
		pageSize: meta?.limit ?? 20,
		total: meta?.total ?? 0,
		showSizeChanger: true,
		showTotal: (total, range) => `${range[0]}–${range[1]} / jami ${total}`,
		className: "px-6 pb-4",
		onChange: onPageChange,
	};
}

export function buildEmptyLocale(text: string) {
	return {
		emptyText: <Empty className="py-12" image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />,
	};
}
