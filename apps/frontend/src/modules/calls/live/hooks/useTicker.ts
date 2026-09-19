import { useEffect, useState } from "react";

/**
 * Har `intervalMs` da `Date.now()` ni yangilaydi. Jonli qo'ng'iroq
 * davomiyligini "tik-tik" ko'rsatish uchun ishlatiladi.
 */
export function useTicker(intervalMs = 1000, enabled = true): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!enabled) {
			return;
		}

		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs, enabled]);

	return now;
}
