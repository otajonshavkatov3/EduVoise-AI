import { type CallEndReason, useCallPopStore } from "../../store/callPop.store";
import type { SipRefs } from "./useSipRefs";

/**
 * Qo'ng'iroqning yakuniy holatini "Muloqot paneli"ga yozadi.
 *
 * BARCHA tugash yo'llari shu yerdan o'tadi — BYE, mahalliy uzish, rad etish,
 * javobsizlik, signalizatsiya xatosi. Avval har bir yo'l o'zicha ishlagani
 * uchun ba'zilari panelni "aktiv" holatda qoldirib ketardi.
 *
 * Bir necha marta chaqirish xavfsiz: `setCallEnded` id bo'yicha moslikni va
 * takrorlanishni o'zi tekshiradi.
 */
export function finishCallPop(refs: SipRefs, durationSeconds: number): void {
	const reason: CallEndReason =
		refs.endReason.current ?? (durationSeconds > 0 ? "completed" : "noAnswer");
	refs.endReason.current = null;

	const payload = {
		status: durationSeconds > 0 ? ("completed" as const) : ("missed" as const),
		endedAt: new Date().toISOString(),
		endReason: reason,
		durationSeconds,
	};

	// Panel ikki xil id bilan ochilgan bo'lishi mumkin: SIP qatlami mahalliy id
	// yozadi, server hodisasi (`incoming_call`) esa backend UUID bilan ochadi.
	// Ikkalasi ham sinaladi — mos kelmagani e'tiborsiz qoladi, mos kelgandan
	// keyingisi esa takroriy bo'lib hech narsani o'zgartirmaydi.
	const candidates = [refs.popCallId.current, refs.backendCallId.current];
	const { setCallEnded } = useCallPopStore.getState();

	for (const callId of candidates) {
		if (callId) {
			setCallEnded({ callId, ...payload });
		}
	}
}
