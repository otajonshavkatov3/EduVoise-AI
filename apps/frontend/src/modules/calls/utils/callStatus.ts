/**
 * Qo'ng'iroq holatlarini aniqlash uchun yordamchi funksiyalar.
 *
 * Bu yerda IKKI xil holat nomlari uchraydi: panel holatlari (`callPop.store` —
 * ringing/active/missed/completed) va SIP sessiya holatlari (`sip.store` —
 * calling/early_media/established/terminating/terminated). Panel ikkalasini ham
 * ko'rsatadi, shuning uchun to'plamlar aralash.
 */

import type { CallPopStatus } from "../store/callPop.store";

/** Panel holatlarining ko'rinadigan nomlari. */
export const CALL_POP_STATUS_LABELS: Record<CallPopStatus, string> = {
	ringing: "Chalinmoqda",
	active: "Suhbatda",
	missed: "Javobsiz",
	completed: "Yakunlangan",
};

const ACTIVE_STATUSES = new Set(["active", "established"]);
const ENDED_STATUSES = new Set(["completed", "missed"]);

/** SIP uzilish oynasi: yakuniy holat hali yozilmagan, lekin suhbat tugagan. */
const SIP_TERMINAL_STATUSES = new Set(["terminating", "terminated"]);

export function isActive(status: string): boolean {
	return ACTIVE_STATUSES.has(status);
}

export function isMissed(status: string): boolean {
	return status === "missed";
}

export function isEnded(status: string): boolean {
	return ENDED_STATUSES.has(status);
}

/**
 * Panelda ko'rsatiladigan holat: SIP holati odatda aniqroq, lekin do'kondagi
 * yakuniy holat ustuvor.
 *
 * Aks holda tugagan qo'ng'iroq yana "aktiv" ko'rinishga qaytadi: SIP
 * `terminating`/`terminated` oynasi hech qanday tugash ko'rinishiga ega emas,
 * `activeCall` esa uzilgandan yarim sekund keyin null bo'ladi va holat
 * eskirgan panel qiymatiga tushib qoladi.
 */
function resolveDisplayStatus(popStatus: string, sipStatus?: string): string {
	if (isEnded(popStatus) || sipStatus === undefined || SIP_TERMINAL_STATUSES.has(sipStatus)) {
		return popStatus;
	}
	return sipStatus;
}

/** Panelning uch ko'rinishi: jiringlash, suhbat, tugagan. */
export type CallPhase = "ringing" | "active" | "ended";

export interface CallPresentation {
	ended: boolean;
	phase: CallPhase;
	/** `DurationCard`ga beriladigan holat. */
	displayStatus: string;
	/** Ko'rsatiladigan davomiylik (sekund). */
	duration: number;
}

/**
 * Panelda nima ko'rinishini hisoblaydi.
 *
 * Alohida turadi, chunki uchta manba kelishtirilishi kerak: paneldagi holat,
 * SIP sessiya holati va timer. Ular mos kelmaganda tugagan qo'ng'iroq yana
 * "aktiv" ko'rinib, timer esa hisoblashda davom etardi.
 */
export function resolveCallPresentation(
	popStatus: string | undefined,
	sipStatus: string | undefined,
	timerDuration: number,
	endedDuration?: number
): CallPresentation {
	const status = popStatus ?? "";
	const ended = isEnded(status);
	const displayStatus = resolveDisplayStatus(status, sipStatus);

	return {
		ended,
		phase: ended ? "ended" : resolveLivePhase(displayStatus),
		displayStatus,
		// Tugagan qo'ng'iroqda SIP qatlami o'lchagan davomiylik ustuvor: timer bir
		// sekundgacha kechikishi mumkin, "missed" holatida esa nolga tushadi.
		duration: ended ? (endedDuration ?? timerDuration) : timerDuration,
	};
}

function resolveLivePhase(displayStatus: string): CallPhase {
	return isActive(displayStatus) ? "active" : "ringing";
}
