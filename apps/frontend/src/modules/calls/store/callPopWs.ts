import type { WsMessage } from "@/shared/hooks/useWebSocket";
import { normalizePhone } from "@/shared/utils/phoneFormat";
import { isEnded } from "../utils/callStatus";
import {
	type CallEndReason,
	type CallEndStatus,
	type IncomingCall,
	useCallPopStore,
} from "./callPop.store";
import { useSipStore } from "./sip.store";

/**
 * Server yuborgan qo'ng'iroq hodisalarini "Muloqot paneli"ga uzatadi.
 *
 * React hook emas — MainLayout'dagi mavjud WebSocket ishlovchisidan chaqiriladi
 * (`handleLiveCallWsMessage` bilan bir xil naqsh). Tanish bo'lmagan turlar
 * e'tiborsiz qoladi.
 */

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * CRM qo'ng'iroq holatini panel holatiga o'giradi.
 *
 * `calls.status` to'plami kengroq ("answered", "abandoned"), panel esa faqat
 * ikki tugash holatini ko'rsatadi. Avval server qiymati to'g'ridan-to'g'ri
 * yozilardi va panel hech qanday ko'rinishi bo'lmagan holatga tushib qolardi.
 */
function toEndStatus(value: unknown): CallEndStatus {
	return value === "missed" || value === "abandoned" ? "missed" : "completed";
}

/**
 * Sabab holatdan chiqariladi. Server `endReason`i ichki diagnostika satri
 * ("stasis-end", "audiosocket-end") — uni foydalanuvchiga ko'rsatib bo'lmaydi.
 */
function toEndReason(status: CallEndStatus): CallEndReason {
	return status === "missed" ? "noAnswer" : "completed";
}

function isSipLegEstablished(): boolean {
	return useSipStore.getState().activeCall?.status === "established";
}

/**
 * Ketayotgan suhbatni server hodisasi bilan tugatish mumkinmi?
 *
 * Yo'naltirilgan qo'ng'iroqda AI qatori tugaydi, mijoz esa operator bilan
 * gaplashishda davom etadi — bunda "tugadi" ko'rsatish yolg'on bo'lardi.
 * Yo'naltirilmagan qo'ng'iroqda esa serverdagi qatorning tugashi kanalning
 * uzilishini bildiradi: SIP `BYE` yo'lda yo'qolgan bo'lsa ham qo'ng'iroq
 * haqiqatan tugagan, panel esa "aktiv" holatda qotib qolmasligi kerak.
 */
function mayEndLiveCall(msg: WsMessage): boolean {
	return readString(msg.transferExtension) === null;
}

/**
 * Xavfsizlik to'ri: SIP `BYE` yetib kelmasa ham panel tugagan holatga o'tadi.
 * `setCallEnded` id bo'yicha moslikni tekshiradi, shuning uchun begona
 * qo'ng'iroqning hodisasi hozirgi panelga ta'sir qilmaydi.
 */
function applyServerEnd(msg: WsMessage): void {
	const callId = readString(msg.callId);
	if (!callId) {
		return;
	}
	if (isSipLegEstablished() && !mayEndLiveCall(msg)) {
		return;
	}

	const status = toEndStatus(msg.status);
	useCallPopStore.getState().setCallEnded({
		callId,
		status,
		endedAt: new Date().toISOString(),
		endReason: toEndReason(status),
		durationSeconds: typeof msg.durationSeconds === "number" ? msg.durationSeconds : undefined,
	});
}

/**
 * Server ochgan panel (masalan stol telefoniga kelgan qo'ng'iroq).
 *
 * Ramkada `status` maydoni yo'q (`notifyOperatorIfAny` uni yubormaydi) —
 * "ringing" yoziladi: holatsiz panel neytral ko'rinishga tushib, jiringlab
 * turgan qo'ng'iroqni tugagan qilib ko'rsatib qo'yardi.
 */
function showServerCall(msg: WsMessage): void {
	const callId = readString(msg.callId);
	if (!callId) {
		return;
	}

	const frame = msg as unknown as IncomingCall;
	const { call, visible, showCall, updateCall } = useCallPopStore.getState();
	const frameNumber = normalizePhone(frame.callerNumber ?? "");

	// SIP qatlami shu qo'ng'iroq uchun panelni allaqachon ochgan bo'lsa, uni
	// qayta ochmasdan backend id (va kontakt) qo'shiladi: qayta ochish mahalliy
	// id'ni va jonli holatni yo'qotib, tugash hodisasini "egasiz" qoldirardi.
	const sameCall =
		visible &&
		call !== null &&
		!isEnded(call.status) &&
		frameNumber.length > 0 &&
		normalizePhone(call.callerNumber) === frameNumber;

	if (sameCall && call !== null) {
		updateCall({ id: callId, contact: call.contact ?? frame.contact ?? null });
		return;
	}

	showCall({ ...frame, callId, status: "ringing" });
}

/**
 * Orkestrator qatorining id'sini panelga bog'laydi.
 *
 * Ichki raqamga qilingan qo'ng'iroqda (900 — AI agent) frontend backend id'ni
 * boshqa yo'l bilan bila olmaydi: `sendCallStartWebhook` ichki raqamlar uchun
 * so'rov yubormaydi (keraksiz ikkinchi `calls` qatori paydo bo'lmasligi uchun).
 * Orkestrator qatorni ochganda `callerNumber` aynan brauzer extension'i bo'ladi
 * — shu moslikda id yoziladi va keyinroq keladigan `live_call_ended` xavfsizlik
 * to'ri sifatida ishlay oladi.
 */
function captureBackendCallId(msg: WsMessage): void {
	if (!isRecord(msg.call)) {
		return;
	}
	const callId = readString(msg.call.callId);
	const callerNumber = readString(msg.call.callerNumber);
	if (!(callId && callerNumber)) {
		return;
	}
	if (callerNumber !== useSipStore.getState().config.extension) {
		return;
	}

	const { call, visible, updateCall } = useCallPopStore.getState();
	if (!visible || call === null || call.id || call.direction !== "outbound") {
		return;
	}
	if (isEnded(call.status)) {
		return;
	}

	updateCall({ id: callId });
}

export function handleCallPopWsMessage(msg: WsMessage): void {
	switch (msg.type) {
		// `outgoing_call` ham shu yerda edi, lekin uni hech kim yubormaydi:
		// panelni ochadigan yagona broadcaster (freepbx webhook) yo'nalishdan
		// qat'i nazar doim `incoming_call` yuboradi. Chiquvchi panel esa SIP
		// qatlami tomonidan mahalliy ochiladi.
		case "incoming_call":
			showServerCall(msg);
			break;
		case "live_call_started":
			captureBackendCallId(msg);
			break;
		case "call_ended":
		case "live_call_ended":
			applyServerEnd(msg);
			break;
		default:
			break;
	}
}
