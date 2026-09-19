import { useCallback, useEffect, useRef } from "react";

/**
 * Kechiktirib chaqiriladigan funksiya.
 *
 * Qidiruv maydonlari uchun: har bosilgan harf uchun so'rov yuborish jadval
 * ochilishida o'nlab keraksiz so'rov degani, natijalar esa foydalanuvchi yozib
 * bo'lgunicha bir necha marta sakraydi.
 *
 * Oxirgi chaqiruv g'olib bo'ladi, komponent yo'q qilinganda kutilayotgan
 * chaqiruv bekor qilinadi (aks holda React yechilgan komponentga holat yozardi).
 */
export function useDebouncedCallback<TArgs extends unknown[]>(
	callback: (...args: TArgs) => void,
	delayMs = 350
): (...args: TArgs) => void {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Har renderdagi yangi closure emas, oxirgisi chaqirilishi uchun.
	const callbackRef = useRef(callback);
	callbackRef.current = callback;

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}
		};
	}, []);

	return useCallback(
		(...args: TArgs) => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				callbackRef.current(...args);
			}, delayMs);
		},
		[delayMs]
	);
}
