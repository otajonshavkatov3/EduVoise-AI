import { Card } from "antd";

/**
 * Every caveat behind the figures above, spelled out.
 *
 * Deliberately a plain list rather than a collapsed panel: an owner reading a
 * money number is entitled to see what it does and does not include without
 * having to click anything.
 */
export function EstimateNotesCard({ notes }: { notes: string[] }) {
	if (notes.length === 0) {
		return null;
	}

	return (
		<Card className="border-slate-100 shadow-sm" styles={{ body: { padding: 20 } }}>
			<div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">
				Raqamlar nimaga asoslangan
			</div>
			<ul className="flex list-none flex-col gap-2 p-0">
				{notes.map((note) => (
					<li
						key={note}
						className="flex gap-2 text-[11px] font-medium leading-relaxed text-slate-400"
					>
						<span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
						<span>{note}</span>
					</li>
				))}
			</ul>
		</Card>
	);
}
