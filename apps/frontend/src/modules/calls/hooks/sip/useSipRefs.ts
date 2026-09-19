import { useRef } from "react";
import type { Registerer, Session, UserAgent } from "sip.js";
import type { CallEndReason } from "../../store/callPop.store";

export interface SipRefs {
	userAgent: React.MutableRefObject<UserAgent | null>;
	registerer: React.MutableRefObject<Registerer | null>;
	currentSession: React.MutableRefObject<Session | null>;
	backendCallId: React.MutableRefObject<string | null>;
	/**
	 * "Muloqot paneli" uchun mahalliy id — panelni ochgan va yopgan hodisalar
	 * aynan shu bo'yicha topishadi.
	 *
	 * NEGA KERAK: ichki raqamlar (900 — AI agent) uchun `backendCallId` hech
	 * qachon kelmaydi (`useSipWebhooks` ular uchun so'rov yubormaydi), shuning
	 * uchun panel id'si SIP qatlamining o'zidan chiqishi kerak.
	 */
	popCallId: React.MutableRefObject<string | null>;
	/**
	 * Tugash sababi. Uzish/rad etish/javobsizlik yo'llari uni belgilaydi,
	 * `SessionState.Terminated` esa panelga yozadi — sabab faqat shu yo'llarda
	 * ma'lum, tugash hodisasi kelganda esa yo'q.
	 */
	endReason: React.MutableRefObject<CallEndReason | null>;
	callStartTime: React.MutableRefObject<number | null>;
	callDuration: React.MutableRefObject<number | null>;
	mediaRecorder: React.MutableRefObject<MediaRecorder | null>;
	recorderChunks: React.MutableRefObject<BlobPart[]>;
	consultationSession: React.MutableRefObject<Session | null>;
	// Ovoz sink'lari: `useSipPhone` bu ikki maydonni `useSipAudio` ref'lari bilan
	// almashtiradi — DOM elementini SipPhoneProvider aynan ularga yozadi.
	remoteAudio: React.MutableRefObject<HTMLAudioElement | null>;
	consultationAudio: React.MutableRefObject<HTMLAudioElement | null>;
}

export function useSipRefs(): SipRefs {
	return {
		userAgent: useRef<UserAgent | null>(null),
		registerer: useRef<Registerer | null>(null),
		currentSession: useRef<Session | null>(null),
		backendCallId: useRef<string | null>(null),
		popCallId: useRef<string | null>(null),
		endReason: useRef<CallEndReason | null>(null),
		callStartTime: useRef<number | null>(null),
		callDuration: useRef<number | null>(null),
		mediaRecorder: useRef<MediaRecorder | null>(null),
		recorderChunks: useRef<BlobPart[]>([]),
		consultationSession: useRef<Session | null>(null),
		remoteAudio: useRef<HTMLAudioElement | null>(null),
		consultationAudio: useRef<HTMLAudioElement | null>(null),
	};
}
