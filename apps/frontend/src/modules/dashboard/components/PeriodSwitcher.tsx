import { Tabs } from "antd";
import type { DashboardPeriod } from "../types";
import { PERIOD_LABELS } from "../utils/format";

interface PeriodSwitcherProps {
	value: DashboardPeriod;
	onChange: (period: DashboardPeriod) => void;
}

const ITEMS = (["day", "week", "month"] as const).map((period) => ({
	key: period,
	label: PERIOD_LABELS[period],
}));

/**
 * Yagona filtr — sahifadagi BARCHA kartochka va diagrammalar shu davrga
 * bo'ysunadi. Har bir diagrammaning ichida alohida filtr yo'q.
 */
export function PeriodSwitcher({ value, onChange }: PeriodSwitcherProps) {
	return (
		<Tabs
			activeKey={value}
			onChange={(key) => onChange(key as DashboardPeriod)}
			className="custom-segmented-tabs"
			items={ITEMS}
		/>
	);
}
