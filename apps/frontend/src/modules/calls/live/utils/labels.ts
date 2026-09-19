import type { AiSessionStatus, LiveCallStatus, TranscriptRole, TransferPhase } from "../types";

interface LabelConfig {
	label: string;
	/** Ant Design Tag rangi. */
	color: string;
	/** Tailwind nuqta klasslari. */
	dotClass: string;
}

export const liveCallStatusConfig: Record<LiveCallStatus, LabelConfig> = {
	starting: { label: "Boshlanmoqda", color: "blue", dotClass: "bg-blue-500 animate-pulse" },
	live: { label: "Jonli suhbat", color: "green", dotClass: "bg-emerald-500 animate-pulse" },
	transferring: { label: "Uzatilmoqda", color: "orange", dotClass: "bg-amber-500 animate-pulse" },
	transferred: { label: "Operatorda", color: "cyan", dotClass: "bg-cyan-500" },
	ending: { label: "Tugatilmoqda", color: "volcano", dotClass: "bg-orange-500 animate-pulse" },
	ended: { label: "Tugadi", color: "default", dotClass: "bg-slate-400" },
};

export const aiSessionStatusConfig: Record<AiSessionStatus, LabelConfig> = {
	initializing: {
		label: "Ishga tushmoqda",
		color: "blue",
		dotClass: "bg-blue-500 animate-pulse",
	},
	active: { label: "AI faol", color: "green", dotClass: "bg-emerald-500 animate-pulse" },
	transferring: { label: "Uzatishda", color: "orange", dotClass: "bg-amber-500 animate-pulse" },
	completed: { label: "Yakunlandi", color: "cyan", dotClass: "bg-cyan-500" },
	failed: { label: "Xatolik", color: "red", dotClass: "bg-rose-500" },
};

export const transferPhaseConfig: Record<TransferPhase, LabelConfig> = {
	none: { label: "Uzatilmagan", color: "default", dotClass: "bg-slate-300" },
	requested: { label: "Uzatish so'raldi", color: "gold", dotClass: "bg-amber-400 animate-pulse" },
	connected: { label: "Operatorga ulandi", color: "green", dotClass: "bg-emerald-500" },
	failed: { label: "Uzatish muvaffaqiyatsiz", color: "red", dotClass: "bg-rose-500" },
};

export const transcriptRoleConfig: Record<TranscriptRole, { label: string; short: string }> = {
	caller: { label: "Mijoz", short: "M" },
	agent: { label: "AI operator", short: "AI" },
	system: { label: "Tizim", short: "T" },
};

/** Provider nomini o'qiladigan matnga aylantiradi. */
export function providerLabel(provider: string | null): string {
	if (!provider) {
		return "Aniqlanmagan";
	}
	if (provider === "openai-realtime") {
		return "OpenAI Realtime";
	}
	// Hozirda aynan shu provayder qo'ng'iroqlarga javob beradi; sharti bo'lmagani
	// uchun jadvallarda xom "gemini-live" satri chiqib turardi.
	if (provider === "gemini-live") {
		return "Gemini Live";
	}
	if (provider === "fallback-ivr") {
		return "Zaxira IVR";
	}
	return provider;
}

/** Sekundlarni m:ss yoki h:mm:ss ko'rinishida qaytaradi. */
export function formatDuration(totalSeconds: number): string {
	const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe % 3600) / 60);
	const seconds = safe % 60;

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Boshlanish vaqtidan hozirgacha o'tgan sekundlar. */
export function elapsedSeconds(startedAt: string, nowMs: number): number {
	const startMs = Date.parse(startedAt);
	if (Number.isNaN(startMs)) {
		return 0;
	}
	return Math.max(0, Math.round((nowMs - startMs) / 1000));
}

/** Audio millisekundlarini "12.3 s" ko'rinishida ko'rsatadi. */
export function formatAudioMs(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms <= 0) {
		return "0 s";
	}
	return `${(ms / 1000).toFixed(1)} s`;
}

/** Faqat vaqt (HH:MM:SS), transkript qatorlari uchun. */
export function formatClock(iso: string): string {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return "--:--:--";
	}
	return parsed.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}
