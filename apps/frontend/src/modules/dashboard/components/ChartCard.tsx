import { Card, Empty, Spin } from "antd";
import type { ReactNode } from "react";
import { refetchOpacity } from "../utils/chartTheme";

interface ChartCardProps {
	title: string;
	subtitle?: string;
	/** Sarlavha o'ngidagi legenda — 2 va undan ko'p qator uchun majburiy. */
	legend?: ReactNode;
	isLoading: boolean;
	isFetching?: boolean;
	/** true bo'lsa diagramma o'rniga haqiqiy bo'sh holat ko'rsatiladi. */
	isEmpty: boolean;
	emptyTitle: string;
	emptyHint?: string;
	/** Chizma + o'q yozuvlari sig'adigan balandlik. */
	bodyMinHeight?: number;
	children: ReactNode;
	footer?: ReactNode;
}

const DEFAULT_MIN_HEIGHT = 320;

export function ChartCard({
	title,
	subtitle,
	legend,
	isLoading,
	isFetching = false,
	isEmpty,
	emptyTitle,
	emptyHint,
	bodyMinHeight = DEFAULT_MIN_HEIGHT,
	children,
	footer,
}: ChartCardProps) {
	const showPlaceholder = isLoading || isEmpty;

	return (
		<Card className="h-full border-slate-100 shadow-sm" styles={{ body: { padding: 24 } }}>
			<div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h3 className="text-lg font-extrabold tracking-tight text-slate-900">{title}</h3>
					{subtitle && <p className="text-xs font-medium text-slate-500">{subtitle}</p>}
				</div>
				{legend && !showPlaceholder && <div className="flex items-center gap-4">{legend}</div>}
			</div>

			{isLoading && (
				<div
					className="flex items-center justify-center"
					style={{ minHeight: bodyMinHeight }}
					aria-busy="true"
				>
					<Spin size="large" />
				</div>
			)}

			{!isLoading && isEmpty && (
				<div className="flex items-center justify-center" style={{ minHeight: bodyMinHeight }}>
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description={
							<div className="text-center">
								<div className="font-bold text-slate-500">{emptyTitle}</div>
								{emptyHint && <div className="mt-1 text-xs text-slate-400">{emptyHint}</div>}
							</div>
						}
					/>
				</div>
			)}

			{!showPlaceholder && (
				<div className={refetchOpacity(isFetching)}>
					{children}
					{footer}
				</div>
			)}
		</Card>
	);
}

interface LegendDotProps {
	color: string;
	label: string;
}

export function LegendDot({ color, label }: LegendDotProps) {
	return (
		<div className="flex items-center gap-2">
			<span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
			<span className="text-xs font-bold text-slate-600">{label}</span>
		</div>
	);
}
