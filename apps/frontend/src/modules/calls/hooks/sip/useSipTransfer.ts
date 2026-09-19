import { useCallback } from "react";
import { Inviter, SessionState, UserAgent } from "sip.js";
import { buildSipUri } from "../../config/sip.config";
import { useSipStore } from "../../store/sip.store";
import { finishCallPop } from "./finishCall";
import { attachRemoteAudio, detachRemoteAudio, setRemoteAudioMuted } from "./remoteAudio";
import type { SipRefs } from "./useSipRefs";

// biome-ignore lint/suspicious/noExplicitAny: Internal SDH
type SdhAny = any;

interface UseSipTransferProps {
	refs: SipRefs;
	config: any;
	endCall: () => void;
}

/** Yo'naltirish paytida suhbat qancha davom etganini beradi. */
function elapsedCallSeconds(refs: SipRefs): number {
	const started = refs.callStartTime.current;
	return started === null ? 0 : Math.floor((Date.now() - started) / 1000);
}

export function useSipTransfer({ refs, config, endCall }: UseSipTransferProps) {
	const { setOnHold } = useSipStore();

	/**
	 * Konsultatsiyadan keyin asosiy qo'ng'iroqni tiklash.
	 *
	 * Konsultatsiya boshlanganda asosiy oyoq IKKI tomondan jimlatiladi: mikrofon
	 * treklari va sink elementi. Ilgari buni faqat `invite()`ning sinxron xato
	 * yo'li qaytarardi, ya'ni hamkasb rad etsa yoki javob bermasa operator jonli
	 * mijoz bilan na gaplasha, na uni eshita oladi — va transfer oynasi hamon
	 * "konsultatsiya" ko'rinishida turadi. Shuning uchun tiklash konsultatsiyaning
	 * HAR BIR tugash yo'lida bajarilishi kerak.
	 */
	const resumeMainLeg = useCallback(() => {
		const mainSession = refs.currentSession.current;

		if (mainSession !== null) {
			const pc = (mainSession.sessionDescriptionHandler as SdhAny)?.peerConnection as
				| RTCPeerConnection
				| undefined;

			pc?.getSenders().forEach((s) => {
				if (s.track) {
					s.track.enabled = true;
				}
			});
		}

		setRemoteAudioMuted(refs.remoteAudio.current, false);
		setOnHold(false);
	}, [refs, setOnHold]);

	const blindTransfer = useCallback(
		async (targetNumber: string): Promise<{ success: boolean; error?: string }> => {
			const session = refs.currentSession.current;
			if (!session || session.state !== SessionState.Established) {
				return { success: false, error: "Qo'ng'iroq hali o'rnatilmagan yoki mavjud emas" };
			}
			const ua = refs.userAgent.current;
			if (!ua) {
				return { success: false, error: "User agent mavjud emas" };
			}

			const targetUri = UserAgent.makeURI(buildSipUri(targetNumber, config.serverIp));
			if (!targetUri) {
				return { success: false, error: "Noto'g'ri raqam" };
			}

			try {
				await session.refer(targetUri, {
					requestDelegate: {
						onAccept: () => {
							refs.currentSession.current = null;
							// Operator uchun qo'ng'iroq shu yerda tugadi. `Terminated` ham
							// keladi, lekin panelni kutib turmaslik kerak — aks holda u
							// "Aktiv bog'lanish" holatida qolib ketardi.
							finishCallPop(refs, elapsedCallSeconds(refs));
							endCall();
						},
					},
					requestOptions: {
						extraHeaders: [`Referred-By: <sip:${config.extension}@${config.serverIp}>`],
					},
				});
				return { success: true };
			} catch (error: unknown) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Uzatish xatosi",
				};
			}
		},
		[refs, config, endCall]
	);

	const startConsultation = useCallback(
		async (targetNumber: string): Promise<{ success: boolean; error?: string }> => {
			const mainSession = refs.currentSession.current;
			if (!mainSession || mainSession.state !== SessionState.Established) {
				return { success: false, error: "Aktiv qo'ng'iroq yo'q" };
			}
			const ua = refs.userAgent.current;
			if (!ua) {
				return { success: false, error: "User agent mavjud emas" };
			}

			// Raqam avval tekshiriladi: noto'g'ri raqamda asosiy qo'ng'iroq hold'da
			// qotib qolmasligi kerak (bu yerda rollback yo'q).
			const targetUri = UserAgent.makeURI(buildSipUri(targetNumber, config.serverIp));
			if (!targetUri) {
				return { success: false, error: "Noto'g'ri raqam" };
			}

			const pc = (mainSession.sessionDescriptionHandler as SdhAny)?.peerConnection as
				| RTCPeerConnection
				| undefined;
			if (pc) {
				pc.getSenders().forEach((s) => {
					if (s.track) {
						s.track.enabled = false;
					}
				});
			}
			// Asosiy qo'ng'iroq hold'da — aks holda operator mijoz bilan hamkasbini
			// bir vaqtda eshitadi.
			setRemoteAudioMuted(refs.remoteAudio.current, true);
			setOnHold(true);

			try {
				const consultInviter = new Inviter(ua, targetUri, {
					sessionDescriptionHandlerOptions: { constraints: { audio: config.audio, video: false } },
				});
				refs.consultationSession.current = consultInviter;

				// Konsultatsiya legi uchun alohida sink va tozalash. `setupSessionHandlers`
				// bu yerda ISHLATILMAYDI: u asosiy qo'ng'iroq store'larini yuritadi,
				// MediaRecorder ochadi va call-end webhook yuboradi.
				consultInviter.stateChange.addListener((state: SessionState) => {
					if (state === SessionState.Established) {
						attachRemoteAudio(consultInviter, refs.consultationAudio.current);
					} else if (state === SessionState.Terminated) {
						detachRemoteAudio(refs.consultationAudio.current);
						// Hamkasb rad etsa yoki go'shakni qo'ysa, o'lik sessiya ref'da
						// qolib ketmasin — keyingi transfer urinishi ham buzilardi.
						if (refs.consultationSession.current === consultInviter) {
							refs.consultationSession.current = null;
						}
						// Konsultatsiya tugadi: mijoz hamon liniyada, uni jimlikda
						// qoldirib bo'lmaydi. Transfer muvaffaqiyatli bo'lgan holatda
						// asosiy sessiya allaqachon yo'q va bu faqat hold holatini
						// tozalaydi.
						resumeMainLeg();
					}
				});

				await consultInviter.invite();
				return { success: true };
			} catch (error: unknown) {
				resumeMainLeg();
				return {
					success: false,
					error: error instanceof Error ? error.message : "Konsultatsiya xatosi",
				};
			}
		},
		[refs, config, resumeMainLeg, setOnHold]
	);

	/**
	 * Konsultatsiyani uzib, asosiy qo'ng'iroqni qaytarish.
	 *
	 * Transfer oynasini yopish ilgari faqat React holatini tozalardi: hamkasb
	 * bilan suhbat jonli qolib ketardi, mijoz esa jimlatilgan holatda — operator
	 * uchun qo'ng'iroq o'lganday ko'rinardi.
	 */
	const cancelConsultation = useCallback(async () => {
		const consultSession = refs.consultationSession.current;

		if (consultSession === null) {
			resumeMainLeg();
			return;
		}

		try {
			if (consultSession.state === SessionState.Established) {
				await consultSession.bye();
			} else if (consultSession instanceof Inviter) {
				await consultSession.cancel();
			}
		} catch {
			/* Sessiya allaqachon tugagan bo'lishi mumkin. */
		}

		refs.consultationSession.current = null;
		// `Terminated` tinglovchisi ham buni chaqiradi, lekin sessiya hech qachon
		// o'rnatilmagan bo'lsa u kelmasligi mumkin. Takroriy chaqiruv zararsiz.
		resumeMainLeg();
	}, [refs, resumeMainLeg]);

	const completeAttendedTransfer = useCallback(async (): Promise<{
		success: boolean;
		error?: string;
	}> => {
		const mainSession = refs.currentSession.current;
		const consultSession = refs.consultationSession.current;

		if (!(mainSession && consultSession)) {
			return { success: false, error: "Sessiyalar topilmadi" };
		}
		if (consultSession.state !== SessionState.Established) {
			return { success: false, error: "Konsultatsiya ulanmagan" };
		}

		try {
			await mainSession.refer(consultSession, {
				requestDelegate: {
					onAccept: () => {
						refs.currentSession.current = null;
						refs.consultationSession.current = null;
						finishCallPop(refs, elapsedCallSeconds(refs));
						endCall();
					},
				},
			});
			return { success: true };
		} catch (error: unknown) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Konsultatsiyali uzatish xatosi",
			};
		}
	}, [refs, endCall]);

	return { blindTransfer, startConsultation, cancelConsultation, completeAttendedTransfer };
}
