/**
 * Sekundlarni HH:MM:SS formatiga o'giradi.
 */
export function formatTime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return [h, m, s].map((v) => (v < 10 ? `0${v}` : v)).join(":");
}
