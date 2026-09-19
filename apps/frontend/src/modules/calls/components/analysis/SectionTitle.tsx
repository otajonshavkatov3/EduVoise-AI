import type { ReactNode } from "react";

/** Karta ichidagi kichik bo'lim sarlavhasi. */
export function SectionTitle({ children }: { children: ReactNode }) {
	return (
		<div className="text-[10px] font-black uppercase tracking-widest text-slate-500">
			{children}
		</div>
	);
}
