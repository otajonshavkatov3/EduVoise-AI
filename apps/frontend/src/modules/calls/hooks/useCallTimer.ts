import { useEffect, useRef, useState } from "react";
import { isEnded } from "../utils/callStatus";

/**
 * Qo'ng'iroq davomiyligi uchun timer hook.
 * Qo'ng'iroq active/established bo'lganda boshlanadi.
 */
export function useCallTimer(
	visible: boolean,
	callStatus?: string,
	sipStatus?: string,
	startTime?: number | null
) {
	const [duration, setDuration] = useState(0);
	const callStartTimeRef = useRef<number | null>(null);

	useEffect(() => {
		const isCurrentlyActive = callStatus === "active" || sipStatus === "established";
		// Tugagan qo'ng'iroqda hisob to'xtaydi va nolga tushirilmaydi: panel
		// yakuniy davomiylikni ko'rsatib turishi kerak.
		const isCompleted = isEnded(callStatus ?? "");

		if (visible && isCurrentlyActive) {
			if (!callStartTimeRef.current) {
				callStartTimeRef.current = startTime || Date.now();
			}

			const interval = setInterval(() => {
				const now = Date.now();
				setDuration(Math.floor((now - (callStartTimeRef.current as number)) / 1000));
			}, 1000);

			return () => clearInterval(interval);
		}

		if (!(isCurrentlyActive || isCompleted)) {
			setDuration(0);
			callStartTimeRef.current = null;
		}
	}, [visible, callStatus, sipStatus, startTime]);

	return duration;
}
