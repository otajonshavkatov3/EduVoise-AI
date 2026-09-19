import { InfoCircleOutlined } from "@ant-design/icons";
import { Card, Tag } from "antd";
import type { ReactNode } from "react";
import type { ConfigSource } from "../types";
import { configSourceColors, configSourceLabels } from "../utils/labels";

interface SectionProps {
	icon: ReactNode;
	title: string;
	subtitle: string;
	/** Shu bo'limda saqlanmagan nechta o'zgarish borligi — 0 bo'lsa ko'rsatilmaydi. */
	changedCount?: number;
	children: ReactNode;
}

/** Sozlamalar sahifasining bir bo'limi — hammasi bir xil ko'rinadi. */
export function ConfigSection({ icon, title, subtitle, changedCount = 0, children }: SectionProps) {
	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<div className="flex items-center gap-3">
					<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
						{icon}
					</div>
					<div>
						<div className="mb-1 text-sm leading-none font-black text-slate-900">{title}</div>
						<div className="text-[9px] leading-none font-bold tracking-widest text-slate-400 uppercase">
							{subtitle}
						</div>
					</div>
				</div>
			}
			extra={
				changedCount > 0 ? (
					<Tag color="gold" className="m-0 rounded-lg border-none text-[10px] font-bold">
						{changedCount} ta saqlanmagan
					</Tag>
				) : null
			}
		>
			{children}
		</Card>
	);
}

interface FieldProps {
	label: string;
	hint?: string;
	error?: string;
	/** Qiymat qayerdan kelayotgani — server aytgan manba, taxmin emas. */
	source?: ConfigSource;
	/** Backend bergan cheklov izohlari: maydon nimani O'ZGARTIRMAYDI. */
	notes?: string[];
	children: ReactNode;
}

/** Bitta maydon: sarlavha, manba yorlig'i, izoh va xato. */
export function ConfigField({ label, hint, error, source, notes, children }: FieldProps) {
	return (
		<div>
			<div className="mb-1 flex items-center justify-between gap-2">
				<span className="text-[9px] font-black tracking-widest text-slate-400 uppercase">
					{label}
				</span>
				{source && (
					<Tag
						color={configSourceColors[source]}
						className="m-0 shrink-0 rounded-md border-none text-[9px] font-bold"
					>
						{configSourceLabels[source]}
					</Tag>
				)}
			</div>
			{children}
			{hint && !error && <div className="mt-1 text-xs font-medium text-slate-500">{hint}</div>}
			{error && <div className="mt-1 text-xs font-bold text-rose-500">{error}</div>}
			{notes?.map((note) => (
				<div
					key={note}
					className="mt-2 flex gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-relaxed font-medium text-amber-700"
				>
					<InfoCircleOutlined className="mt-0.5 shrink-0" />
					<span>{note}</span>
				</div>
			))}
		</div>
	);
}
