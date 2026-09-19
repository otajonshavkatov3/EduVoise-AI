import type { TranscriptRole } from "../types/transcript";

export interface RoleStyle {
	label: string;
	/** Avatar ichidagi qisqa belgi */
	short: string;
	avatarClass: string;
	bubbleClass: string;
	/** Chat ko'rinishida qaysi tomonda turadi */
	side: "left" | "right" | "center";
}

export const ROLE_STYLES: Record<TranscriptRole, RoleStyle> = {
	caller: {
		label: "Mijoz",
		short: "M",
		avatarClass: "border border-slate-200 bg-slate-100 text-slate-500",
		bubbleClass: "border-slate-200 bg-slate-50 text-slate-900",
		side: "left",
	},
	agent: {
		label: "Operator / AI",
		short: "A",
		avatarClass: "border border-blue-100 bg-blue-50 text-blue-600",
		bubbleClass: "border-blue-100 bg-blue-50 text-slate-900",
		side: "right",
	},
	system: {
		label: "Tizim",
		short: "T",
		avatarClass: "border border-slate-200 bg-slate-50 text-slate-400",
		bubbleClass: "border-dashed border-slate-200 bg-white text-slate-500 italic",
		side: "center",
	},
};

/** Millisekundni [mm:ss] ko'rinishiga o'giradi. */
export function formatOffset(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms < 0) {
		return "--:--";
	}
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export interface TextSegment {
	text: string;
	isMatch: boolean;
	/** Matndagi boshlanish pozitsiyasi — React kaliti uchun barqaror qiymat */
	start: number;
}

/**
 * Matnni qidiruv so'zi bo'yicha bo'laklarga ajratadi (belgilash uchun).
 * Regexdan foydalanmaydi — foydalanuvchi kiritgan maxsus belgilar xavfsiz.
 */
export function splitByQuery(text: string, query: string): TextSegment[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) {
		return [{ text, isMatch: false, start: 0 }];
	}

	const segments: TextSegment[] = [];
	const haystack = text.toLowerCase();
	let cursor = 0;

	while (cursor < text.length) {
		const found = haystack.indexOf(needle, cursor);
		if (found === -1) {
			segments.push({ text: text.slice(cursor), isMatch: false, start: cursor });
			break;
		}
		if (found > cursor) {
			segments.push({ text: text.slice(cursor, found), isMatch: false, start: cursor });
		}
		segments.push({
			text: text.slice(found, found + needle.length),
			isMatch: true,
			start: found,
		});
		cursor = found + needle.length;
	}

	return segments;
}

/** Ishonch darajasini (0-100) foizga aylantiradi. */
export function formatConfidence(confidence: number | null): string | null {
	if (confidence === null || !Number.isFinite(confidence)) {
		return null;
	}
	return `${Math.round(confidence)}%`;
}
