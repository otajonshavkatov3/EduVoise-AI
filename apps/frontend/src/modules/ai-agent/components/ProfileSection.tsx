import { Card } from "antd";
import type { ReactNode } from "react";

interface SectionProps {
	icon: ReactNode;
	title: string;
	subtitle: string;
	children: ReactNode;
}

/** Biznes profili shaklining bir bo'limi — barcha bo'limlar bir xil ko'rinadi. */
export function ProfileSection({ icon, title, subtitle, children }: SectionProps) {
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
		>
			{children}
		</Card>
	);
}

interface FieldProps {
	label: string;
	hint?: string;
	error?: string;
	children: ReactNode;
}

/** Bitta maydon: sarlavha, izoh va xato — antd Form holatidan mustaqil. */
export function ProfileField({ label, hint, error, children }: FieldProps) {
	return (
		<div>
			<div className="mb-1 text-[9px] font-black tracking-widest text-slate-400 uppercase">
				{label}
			</div>
			{children}
			{hint && !error && <div className="mt-1 text-xs font-medium text-slate-500">{hint}</div>}
			{error && <div className="mt-1 text-xs font-bold text-rose-500">{error}</div>}
		</div>
	);
}
