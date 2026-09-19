import { useEffect, useState } from "react";

/**
 * Tugagan qo'ng'iroq paneli shuncha sekund ko'rinib turadi.
 *
 * Jonli qo'ng'iroqlar doskasida tugagan qator 90 sekund saqlanadi
 * (`ENDED_RETENTION_MS`), lekin bu panel ekran burchagini egallaydi va
 * klaviaturani yopib turadi — shuning uchun o'nlab sekund emas, bir necha
 * sekund.
 */
const ENDED_DISMISS_SECONDS = 8;

/**
 * Tugagan panelni sanoq bilan yopadi va qolgan sekundlarni qaytaradi
 * (`null` — sanoq yurmayapti).
 *
 * Foydalanuvchi kutmasdan ham yopishi mumkin: sarlavhadagi ✕ va
 * "PANELNI YOPISH" tugmasi ishlab turadi.
 */
export function useEndedAutoDismiss(
	ended: boolean,
	onDismiss: () => void,
	/**
	 * Sanoqni to'xtatib turadi.
	 *
	 * Panelni yopish uning ichidagi barcha oynani ham yo'q qiladi. Qo'ng'iroqdan
	 * keyin operator aynan shu paytda chipta yoki eslatma yozadi, ya'ni sanoq
	 * to'xtatilmasa yarim yozilgan forma saqlanmasdan yo'qoladi.
	 */
	paused = false
): number | null {
	const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

	useEffect(() => {
		if (!ended) {
			setSecondsLeft(null);
			return;
		}

		// Pauza tugaganda sanoq boshidan boshlanadi: chiptasini saqlab chiqqan
		// operator uchun panel bir sekundda yo'q bo'lib ketmasligi kerak.
		if (!paused) {
			setSecondsLeft(ENDED_DISMISS_SECONDS);
		}
	}, [ended, paused]);

	useEffect(() => {
		if (!ended || paused || secondsLeft === null || secondsLeft <= 0) {
			return;
		}
		const timer = setTimeout(() => setSecondsLeft(secondsLeft - 1), 1000);
		return () => clearTimeout(timer);
	}, [ended, paused, secondsLeft]);

	useEffect(() => {
		if (!paused && secondsLeft === 0) {
			onDismiss();
		}
	}, [paused, secondsLeft, onDismiss]);

	// Pauzada sanoq ko'rsatilmaydi: yurmayotgan raqamni ko'rsatish yolg'on bo'ladi.
	return paused ? null : secondsLeft;
}
