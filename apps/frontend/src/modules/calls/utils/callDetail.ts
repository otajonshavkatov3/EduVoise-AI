import type { TranscriptFilters, TranscriptLine } from "../types/transcript";

/** Fayl hajmi. Null — server hajmni yozmagan; 0 bayt deb ko'rsatilmaydi. */
export function formatBytes(bytes: number | null): string | null {
	if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
		return null;
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const kb = bytes / 1024;
	if (kb < 1024) {
		return `${kb.toFixed(0)} KB`;
	}
	return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Transkriptni brauzerda filtrlaydi.
 *
 * `GET /calls/{id}/full` butun transkriptni bitta javobda beradi, shuning uchun
 * qidiruv, rol va tartib har bosishda serverga qaytishni talab qilmaydi.
 * `includeInterim` esa serverdan so'raladi — oraliq qatorlar javobga umuman
 * qo'shilmagan bo'lishi mumkin.
 */
export function filterTranscript(
	lines: TranscriptLine[],
	filters: TranscriptFilters
): TranscriptLine[] {
	const needle = filters.search?.trim().toLowerCase() ?? "";
	let result = lines;

	if (filters.role) {
		result = result.filter((line) => line.role === filters.role);
	}
	if (needle.length > 0) {
		result = result.filter((line) => line.content.toLowerCase().includes(needle));
	}
	// Server qatorlarni aytilish tartibida beradi, shuning uchun teskari tartib —
	// oddiy teskarilash (qayta saralash vaqt tamg'asi yo'q qatorlarni aralashtirardi).
	return filters.order === "desc" ? [...result].reverse() : result;
}

/**
 * Mijoz gapirganmi. Qayta tahlil faqat shunda ma'noga ega — backend ham aynan
 * shu shartni tekshiradi.
 */
export function hasCallerLine(lines: TranscriptLine[]): boolean {
	return lines.some((line) => line.role === "caller" && line.content.trim().length > 0);
}
