import { create } from "zustand";
import { isEnded } from "../utils/callStatus";

export interface IncomingCallContact {
	id: string;
	firstName: string | null;
	lastName: string | null;
	contactName?: string | null;
	address:
		| {
				tuman?: string;
				kocha?: string;
				uy?: string;
		  }
		| string
		| null;
	notes?: string | null;
}

/**
 * Panelda ko'rinadigan qo'ng'iroq holatlari.
 *
 * Faqat shu to'rtta qiymat yoziladi va ko'rsatiladi. Avval bu yerda "answered"
 * va "ended" ham bor edi, lekin ularni hech bir kod yozmasdi — natijada
 * ko'rinishi bo'lmagan holatlar uchun shoxlar yozilib, tugash holati sezilmay
 * ishdan chiqib qolgan edi.
 */
export type CallPopStatus = "ringing" | "active" | "missed" | "completed";

/** Tugash holatlari — `setCallEnded` faqat shulardan birini yozadi. */
export type CallEndStatus = Extract<CallPopStatus, "missed" | "completed">;

/**
 * Qo'ng'iroq nima uchun tugadi.
 *
 * Holatning o'zi yetarli emas: javobsiz qolgan kiruvchi qo'ng'iroq bilan uzoq
 * tomon rad etgan yoki band bo'lgan chiquvchi qo'ng'iroq bir xil "missed"
 * holatiga tushadi, panelda esa ular boshqa-boshqa ko'rinishi kerak.
 */
export type CallEndReason = "completed" | "cancelled" | "rejected" | "busy" | "noAnswer" | "failed";

export interface IncomingCall {
	id?: string;
	callId: string;
	direction: "inbound" | "outbound";
	callerNumber: string;
	calleeExtension: string;
	startedAt: string;
	endedAt?: string;
	status: CallPopStatus;
	/** Tugash sababi — panelning yakuniy matnini shu belgilaydi. */
	endReason?: CallEndReason;
	/** SIP qatlami o'lchagan aniq davomiylik (sekund), timer emas. */
	durationSeconds?: number;
	contact: IncomingCallContact | null;
}

export interface CallEndedPayload {
	callId: string;
	status: CallEndStatus;
	endedAt: string;
	endReason?: CallEndReason;
	durationSeconds?: number;
}

interface CallPopState {
	call: IncomingCall | null;
	visible: boolean;
}

interface CallPopActions {
	showCall: (call: IncomingCall) => void;
	updateCall: (call: Partial<IncomingCall>) => void;
	setCallEnded: (data: CallEndedPayload) => void;
	dismissCall: () => void;
}

type CallPopStore = CallPopState & CallPopActions;

export const useCallPopStore = create<CallPopStore>((set) => ({
	call: null,
	visible: false,

	showCall: (call) => set({ call, visible: true }),

	updateCall: (partialCall) =>
		set((state) => ({
			call: state.call ? { ...state.call, ...partialCall } : null,
		})),

	/**
	 * Qo'ng'iroqni tugagan holatga o'tkazadi.
	 *
	 * `callId` bo'yicha moslik SHART: bitta operatorga bir vaqtda bir nechta
	 * tugash hodisasi kelishi mumkin (SIP BYE, `call_ended`, `live_call_ended`,
	 * parallel stol telefoni legi, oldingi qo'ng'iroqning kechikkan webhook'i) —
	 * begona hodisa hozir ketayotgan suhbat panelini yopib qo'ymasligi kerak.
	 *
	 * Allaqachon tugagan panel esa o'zgartirilmaydi: birinchi kelgan hodisa
	 * sababni belgilaydi, keyingilari yopilish sanog'ini qaytadan boshlamaydi.
	 */
	setCallEnded: (data) =>
		set((state) => {
			const call = state.call;
			if (!call) {
				return state;
			}
			if (!(call.callId === data.callId || call.id === data.callId)) {
				return state;
			}
			if (isEnded(call.status)) {
				return state;
			}
			return {
				call: {
					...call,
					status: data.status,
					endedAt: data.endedAt,
					endReason: data.endReason ?? call.endReason,
					durationSeconds: data.durationSeconds ?? call.durationSeconds,
				},
			};
		}),

	dismissCall: () => set({ visible: false, call: null }),
}));
