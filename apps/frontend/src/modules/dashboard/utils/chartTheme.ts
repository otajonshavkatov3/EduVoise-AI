/**
 * Dashboard diagrammalarining yagona ko'rinishi.
 *
 * Ranglar loyiha tokenlaridan olingan (index.css): primary #2154b2, emerald-500,
 * rose-500, muted #64748b. Javob berilgan/javobsiz juftligi rang ko'rlik uchun
 * tekshirilgan (protan ΔE 18.2, oddiy ko'rish ΔE 36.4). Kayfiyat esa qutbli
 * shkala: iliq (salbiy) — kulrang (neytral) — sovuq/yashil (ijobiy).
 */
export const CHART_COLORS = {
	answered: "#2154b2",
	unanswered: "#f43f5e",
	series: "#2154b2",
	positive: "#10b981",
	neutral: "#64748b",
	negative: "#f43f5e",
} as const;

/** Setka va o'qlar — yuzadan bir pog'ona farq qiladigan yupqa, uzluksiz chiziq. */
export const GRID_STROKE = "#f1f5f9";

export const AXIS_TICK = { fill: "#94a3b8", fontSize: 12, fontWeight: 500 } as const;

export const CATEGORY_TICK = { fill: "#64748b", fontSize: 11, fontWeight: 700 } as const;

export const TOOLTIP_CONTENT_STYLE = {
	backgroundColor: "rgba(255, 255, 255, 0.96)",
	backdropFilter: "blur(8px)",
	border: `1px solid ${GRID_STROKE}`,
	borderRadius: "12px",
	boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1)",
	padding: "12px",
} as const;

export const TOOLTIP_LABEL_STYLE = {
	marginBottom: "4px",
	fontWeight: "bold",
	color: "#0f172a",
} as const;

export const TOOLTIP_ITEM_STYLE = { fontSize: "12px", fontWeight: "bold" } as const;

export const TOOLTIP_CURSOR_FILL = { fill: "#f8fafc" } as const;

/** Yuklanish/yangilanish paytida oldingi chizma o'rnida qoladi, sakramaydi. */
export function refetchOpacity(isFetching: boolean): string {
	return isFetching ? "opacity-60 transition-opacity" : "transition-opacity";
}
