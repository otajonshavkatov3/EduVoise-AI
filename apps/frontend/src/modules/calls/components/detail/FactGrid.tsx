import type { ReactNode } from "react";

/**
 * Yorliq + qiymat juftligi.
 *
 * Ma'lum bo'lmagan qiymat uchun `value` ni bermang — o'rniga `empty` matni
 * kursivda chiqadi, ya'ni "yo'q" va "0" bir xil ko'rinmaydi.
 */
export function Fact({
	label,
	value,
	empty = "—",
	hint,
}: {
	label: string;
	value?: ReactNode;
	empty?: string;
	hint?: string;
}) {
	return (
		<div className="min-w-0">
			<div className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</div>
			<div className="mt-1 break-words text-sm font-bold text-slate-800">
				{value ?? <span className="text-xs font-medium italic text-slate-400">{empty}</span>}
			</div>
			{hint && <div className="mt-0.5 text-[10px] font-medium text-slate-400">{hint}</div>}
		</div>
	);
}

export function FactGrid({ children }: { children: ReactNode }) {
	return (
		<div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
	);
}
