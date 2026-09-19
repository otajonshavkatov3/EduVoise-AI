import { useCallback } from "react";
import { Invitation, Inviter, type Session, SessionState, UserAgent } from "sip.js";
import type { SipConfig } from "../../config/sip.config";
import { buildSipUri } from "../../config/sip.config";
import { type CallEndReason, useCallPopStore } from "../../store/callPop.store";
import { useSipStore } from "../../store/sip.store";
import { finishCallPop } from "./finishCall";
import { setRemoteAudioMuted } from "./remoteAudio";
import type { SipRefs } from "./useSipRefs";

// biome-ignore lint/suspicious/noExplicitAny: Internal SDH
type SdhAny = any;

/**
 * SIP javob kodini panel ko'rsatadigan sababga o'giradi.
 *
 * Kodning o'zi `errorMessage`ga tushadi, u esa faqat sozlamalar sahifasida
 * ko'rinadi — qo'ng'iroq paytida operator sababni odam tilida ko'rishi kerak.
 */
function endReasonFromStatusCode(code: number): CallEndReason {
	if (code === 486 || code === 600) {
		return "busy";
	}
	if (code === 408 || code === 480) {
		return "noAnswer";
	}
	if (code === 487) {
		return "cancelled";
	}
	if (code === 403 || code === 404 || code === 603) {
		return "rejected";
	}
	return "failed";
}

/**
 * Sessiyani holatiga mos usul bilan uzadi: o'rnatilmagan chiquvchi qo'ng'iroq
 * CANCEL, javob berilmagan kiruvchisi REJECT, ulangan suhbat esa BYE bilan.
 */
async function terminateSession(session: Session): Promise<void> {
	if (session.state === SessionState.Established) {
		await session.bye();
		return;
	}
	if (session.state !== SessionState.Initial && session.state !== SessionState.Establishing) {
		return;
	}
	if (session instanceof Inviter) {
		await session.cancel();
		return;
	}
	if (session instanceof Invitation) {
		await session.reject();
	}
}

function elapsedSeconds(startedAtMs: number | null): number {
	return startedAtMs === null ? 0 : Math.floor((Date.now() - startedAtMs) / 1000);
}

interface UseSipCallActionsProps {
	refs: SipRefs;
	config: SipConfig;
	isRegistered: boolean;
	playRingtone: () => void;
	stopRingtone: () => void;
	setupSessionHandlers: (session: Session) => void;
	sendCallStartWebhook: (
		dir: "inbound" | "outbound",
		number: string,
		ext?: string
	) => Promise<string | null>;
	endCall: () => void;
}

export function useSipCallActions({
	refs,
	config,
	isRegistered,
	playRingtone,
	stopRingtone,
	setupSessionHandlers,
	sendCallStartWebhook,
	endCall,
}: UseSipCallActionsProps) {
	const { setError, startOutgoingCall, setCallStatus, setMuted, setOnHold } = useSipStore();
	const activeCall = useSipStore((s) => s.activeCall);

	const makeCall = useCallback(
		async (targetNumber: string) => {
			if (!targetNumber.trim()) {
				return setError("Telefon raqamini kiriting");
			}
			if (!(refs.userAgent.current && isRegistered)) {
				return setError("Avval SIP serverga ulaning");
			}

			const targetUri = UserAgent.makeURI(buildSipUri(targetNumber, config.serverIp));
			if (!targetUri) {
				return setError("Noto'g'ri telefon raqami");
			}

			startOutgoingCall(targetNumber);
			playRingtone();

			// Panel id'si bir marta yaratiladi va tugash hodisasiga aynan shu beriladi.
			// Avval panel `outgoing-<vaqt>`, SIP do'koni esa `call-<vaqt>` yozardi —
			// ikki xil id hech qachon mos kelmagani uchun tugash hodisasi jimgina
			// e'tiborsiz qolardi.
			const popCallId = `sip-out-${Date.now()}`;
			refs.popCallId.current = popCallId;
			refs.backendCallId.current = null;
			refs.endReason.current = null;

			const { showCall } = useCallPopStore.getState();
			showCall({
				callId: popCallId,
				direction: "outbound",
				callerNumber: config.extension,
				calleeExtension: targetNumber,
				startedAt: new Date().toISOString(),
				status: "ringing",
				contact: null,
			});

			try {
				sendCallStartWebhook("outbound", targetNumber, config.extension)
					.then((id) => {
						if (id) {
							refs.backendCallId.current = id;
						}
					})
					.catch(() => {
						// Webhook faqat qo'shimcha qayd uchun — u yiqilsa qo'ng'iroq
						// davom etadi, shuning uchun xato foydalanuvchiga chiqarilmaydi.
					});

				const inviter = new Inviter(refs.userAgent.current, targetUri, {
					sessionDescriptionHandlerOptions: { constraints: { audio: config.audio, video: false } },
					earlyMedia: true,
				});

				refs.currentSession.current = inviter;
				setupSessionHandlers(inviter);

				await inviter.invite({
					requestDelegate: {
						onProgress: (response: SdhAny) => {
							if (response.message.statusCode === 183) {
								setCallStatus("early_media");
							} else if (response.message.statusCode === 180) {
								setCallStatus("ringing");
							}
						},
						onReject: (response: SdhAny) => {
							const code = response.message.statusCode as number;
							refs.endReason.current = endReasonFromStatusCode(code);
							setError(`Qo'ng'iroq rad etildi (${code})`);
						},
					},
				});
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : "Qo'ng'iroq qilishda xato";
				setError(`Qo'ng'iroq xatosi: ${msg}`);
				// INVITE yo'lga chiqmadi — `Terminated` kelmasligi mumkin, shuning uchun
				// panel yakuniy holatga shu yerdan o'tkaziladi.
				refs.endReason.current = "failed";
				finishCallPop(refs, 0);
				endCall();
			}
		},
		[
			refs,
			isRegistered,
			config,
			setError,
			startOutgoingCall,
			playRingtone,
			sendCallStartWebhook,
			setupSessionHandlers,
			setCallStatus,
			endCall,
		]
	);

	const answerCall = useCallback(async () => {
		const session = refs.currentSession.current;
		if (!(session && session instanceof Invitation)) {
			return;
		}
		try {
			stopRingtone();
			await session.accept({
				sessionDescriptionHandlerOptions: { constraints: { audio: config.audio, video: false } },
			});
		} catch (error: unknown) {
			setError(error instanceof Error ? error.message : "Javob berish xatosi");
		}
	}, [refs, config.audio, stopRingtone, setError]);

	const rejectCall = useCallback(async () => {
		const session = refs.currentSession.current;
		if (!(session && session instanceof Invitation)) {
			return;
		}
		refs.endReason.current = "rejected";
		try {
			await session.reject();
			stopRingtone();
			refs.currentSession.current = null;
			endCall();
		} catch (error) {
			setError(error instanceof Error ? error.message : "Qo'ng'iroqni rad etib bo'lmadi");
			finishCallPop(refs, 0);
		}
	}, [refs, stopRingtone, endCall, setError]);

	const hangup = useCallback(async () => {
		const session = refs.currentSession.current;
		if (!session) {
			return;
		}
		// Sabab uzish paytida ma'lum: javobdan oldin uzilgan chiquvchi qo'ng'iroq
		// "bekor qilindi", ulangan suhbat esa oddiy tugash.
		const wasEstablished = session.state === SessionState.Established;
		refs.endReason.current = wasEstablished ? "completed" : "cancelled";
		refs.currentSession.current = null;

		try {
			await terminateSession(session);
			// Muvaffaqiyatli yo'lda yakuniy holatni `SessionState.Terminated` yozadi
			// (sip.js uni `bye()`/`cancel()` ichida beradi). Avval bu yerda darhol
			// `endCall()` chaqirilib, panel "tugadi" holatini ko'rsatishga
			// ulgurmasdi — u SIP holati bilan birga yo'qolib ketardi.
		} catch (error: unknown) {
			setError(error instanceof Error ? error.message : "Qo'ng'iroqni uzishda xato");
			// Signalizatsiya yiqilsa `Terminated` kelmaydi — panel "aktiv" holatda
			// qotib qolmasligi uchun yakuniy holat shu yerda yoziladi.
			refs.endReason.current = "failed";
			finishCallPop(refs, elapsedSeconds(refs.callStartTime.current));
			endCall();
		}
	}, [refs, endCall, setError]);

	const sendDTMF = useCallback(
		(digit: string) => {
			const session = refs.currentSession.current;
			if (session?.state === SessionState.Established) {
				const sdh = session.sessionDescriptionHandler as SdhAny;
				if (typeof sdh?.sendDtmf === "function") {
					sdh.sendDtmf(digit);
				}
			}
		},
		[refs]
	);

	const toggleMute = useCallback(() => {
		const session = refs.currentSession.current;
		if (session?.state === SessionState.Established) {
			const pc = (session.sessionDescriptionHandler as SdhAny)?.peerConnection as
				| RTCPeerConnection
				| undefined;
			if (pc) {
				const currentlyMuted = activeCall?.isMuted ?? false;
				pc.getSenders().forEach((s) => {
					if (s.track?.kind === "audio") {
						s.track.enabled = currentlyMuted;
					}
				});
				setMuted(!currentlyMuted);
			}
		}
	}, [refs, activeCall?.isMuted, setMuted]);

	const toggleHold = useCallback(async () => {
		const session = refs.currentSession.current;
		if (session?.state === SessionState.Established) {
			const currentlyOnHold = activeCall?.isOnHold ?? false;
			const pc = (session.sessionDescriptionHandler as SdhAny)?.peerConnection as
				| RTCPeerConnection
				| undefined;
			if (pc) {
				pc.getSenders().forEach((s) => {
					if (s.track) {
						s.track.enabled = currentlyOnHold;
					}
				});
				// Ovoz sink'i paydo bo'lgach, faqat mikrofonni o'chirish "hold"
				// bo'lmaydi — operator mijozni eshitib turadi. Uzoq tomon ovozi ham
				// jim qilinadi (trek emas, element: yozuvda teshik qolmasin).
				setRemoteAudioMuted(refs.remoteAudio.current, !currentlyOnHold);
				setOnHold(!currentlyOnHold);
			}
		}
	}, [refs, activeCall?.isOnHold, setOnHold]);

	return { makeCall, answerCall, rejectCall, hangup, sendDTMF, toggleMute, toggleHold };
}
