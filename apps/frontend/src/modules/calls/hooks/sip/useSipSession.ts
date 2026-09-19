import { useCallback } from "react";
import type { Invitation } from "sip.js";
import { SessionState } from "sip.js";
import { useCallPopStore } from "../../store/callPop.store";
import { useSipStore } from "../../store/sip.store";
import { showCallNotification } from "../../utils/notification";
import { finishCallPop } from "./finishCall";
import {
	attachRemoteAudio,
	clearAudioBlockedNotice,
	createRemoteRecordingStream,
	detachRemoteAudio,
} from "./remoteAudio";
import type { SipRefs } from "./useSipRefs";

interface UseSipSessionProps {
	refs: SipRefs;
	config: any;
	uploadRecording: (blob: Blob) => Promise<string | null>;
	sendCallEndWebhook: (id: string | null, duration: number, path?: string) => Promise<void>;
	sendCallStartWebhook: (
		dir: "inbound" | "outbound",
		number: string,
		ext?: string
	) => Promise<string | null>;
	playRingtone: () => void;
	stopRingtone: () => void;
	startNetworkMonitoring: (session: any) => void;
	stopNetworkMonitoring: () => void;
	endCall: () => void;
}

export function useSipSession({
	refs,
	config,
	uploadRecording,
	sendCallEndWebhook,
	sendCallStartWebhook,
	playRingtone,
	stopRingtone,
	startNetworkMonitoring,
	stopNetworkMonitoring,
	endCall,
}: UseSipSessionProps) {
	const setupRemoteMedia = useCallback(
		(session: any) => {
			// Ovoz avval ulanadi: Chrome remote trekni faqat sink mavjud bo'lganda
			// dekodlaydi, ya'ni MediaRecorder ham shundan keyin haqiqiy audio oladi.
			attachRemoteAudio(session, refs.remoteAudio.current);

			const recordingStream = createRemoteRecordingStream(session);
			if (!recordingStream) {
				return;
			}

			try {
				const recorder = new MediaRecorder(recordingStream, { mimeType: "audio/webm" });
				refs.recorderChunks.current = [];
				recorder.ondataavailable = (e) => {
					if (e.data?.size > 0) {
						refs.recorderChunks.current.push(e.data);
					}
				};
				recorder.onstop = async () => {
					const durationSeconds = refs.callDuration.current ?? 0;
					refs.callDuration.current = null;
					const callId = refs.backendCallId.current;

					if (refs.recorderChunks.current.length === 0) {
						if (durationSeconds > 0) {
							sendCallEndWebhook(callId, durationSeconds).catch(() => {
								/* Ignore webhook failure on session end */
							});
						}
						return;
					}

					const blob = new Blob(refs.recorderChunks.current, { type: "audio/webm" });
					refs.recorderChunks.current = [];
					const path = await uploadRecording(blob);
					sendCallEndWebhook(callId, durationSeconds, path ?? undefined).catch(() => {
						/* Ignore webhook failure on session end */
					});
				};
				refs.mediaRecorder.current = recorder;
				recorder.start();
			} catch {
				/* Failed to initialize MediaRecorder - recording will not be available for this session */
			}
		},
		[refs, sendCallEndWebhook, uploadRecording]
	);

	const setupSessionHandlers = useCallback(
		(session: any) => {
			session.stateChange.addListener((state: SessionState) => {
				const { setCallStatus } = useSipStore.getState();

				switch (state) {
					case SessionState.Establishing:
						setCallStatus("calling");
						// `earlyMedia: true` bilan 183 Session Progress'da SDH remote
						// tavsifni allaqachon o'rnatadi — ringback/IVR ovozi shu yerda
						// keladi. Sink ulanmasa u yo'qoladi.
						attachRemoteAudio(session, refs.remoteAudio.current);
						useCallPopStore.getState().updateCall({ status: "ringing" });
						break;

					case SessionState.Established:
						setCallStatus("established");
						setupRemoteMedia(session);
						startNetworkMonitoring(session);
						stopRingtone();
						refs.callStartTime.current = Date.now();
						useCallPopStore.getState().updateCall({ status: "active" });
						break;

					case SessionState.Terminating:
						setCallStatus("terminating");
						break;

					case SessionState.Terminated: {
						// Biz allaqachon o'tib ketgan qo'ng'iroqning kechikkan Terminated'i
						// (odatda uzatilgan oyoqning BYE'si) hozir jonli bo'lgan qo'ng'iroqni
						// buzmasligi kerak: aks holda yangi sessiya nolga chiqadi, ovozi
						// uziladi va paneli "tugadi" bo'lib qoladi — suhbat davom etayotgan
						// bo'lsa ham.
						const current = refs.currentSession.current;

						if (current !== null && current !== session) {
							break;
						}

						setCallStatus("terminated");
						refs.currentSession.current = null;
						stopRingtone();
						stopNetworkMonitoring();
						// "track" tinglovchilari va o'lik stream keyingi qo'ng'iroqqa
						// o'tib ketmasin. FAQAT asosiy sink: konsultatsiya oyog'i alohida
						// sessiya bo'lib, mijoz go'shakni qo'yganda ham jonli qoladi —
						// uni shu yerdan uzish operatorni hamkasbi bilan jimlikda qoldiradi.
						detachRemoteAudio(refs.remoteAudio.current);
						clearAudioBlockedNotice();

						const started = refs.callStartTime.current;
						if (started) {
							refs.callDuration.current = Math.floor((Date.now() - started) / 1000);
							refs.callStartTime.current = null;
						}

						// Yakuniy holat panelga shu yerdan yoziladi: uzoq tomon uzganda ham,
						// operator uzganda ham SIP shu holatga keladi.
						finishCallPop(refs, refs.callDuration.current || 0);

						// Yozuvchi bo'lmasa (masalan Safari "audio/webm"ni qo'llamaydi) ham
						// call-end webhook yuborilishi kerak — avval `?.state !== "inactive"`
						// null holatda ham rost bo'lib, `?.stop()` bo'sh ishlagan va webhook
						// hech qachon ketmagan.
						const recorder = refs.mediaRecorder.current;
						refs.mediaRecorder.current = null;
						if (recorder && recorder.state !== "inactive") {
							try {
								// `onstop` yozuvni yuklab, webhookni o'zi yuboradi.
								recorder.stop();
							} catch {
								/* Ignore stop error if recorder is already stopped */
							}
						} else if (refs.callDuration.current != null) {
							sendCallEndWebhook(refs.backendCallId.current, refs.callDuration.current).catch(
								() => {
									/* Ignore webhook failure on session end */
								}
							);
							refs.callDuration.current = null;
						}

						// `backendCallId` bu yerda tozalanmaydi: `recorder.onstop` asinxron
						// ishga tushib, webhookni aynan shu id bilan yuboradi. Har bir yangi
						// qo'ng'iroq boshida u nolga chiqariladi, shuning uchun eskirgan id
						// keyingi qo'ng'iroqqa o'tib ketmaydi.
						refs.popCallId.current = null;
						setTimeout(() => endCall(), 500);
						break;
					}
				}
			});
		},
		[
			refs,
			endCall,
			setupRemoteMedia,
			sendCallEndWebhook,
			startNetworkMonitoring,
			stopRingtone,
			stopNetworkMonitoring,
		]
	);

	const handleIncomingCall = useCallback(
		(invitation: Invitation) => {
			const callerUser = invitation.remoteIdentity?.uri?.user || "Noma'lum";
			const callerName = invitation.remoteIdentity?.displayName || callerUser;

			refs.currentSession.current = invitation;
			useSipStore.getState().startIncomingCall(callerUser, callerName);
			playRingtone();

			// Panel id'si bir marta yaratiladi va tugash hodisasiga aynan shu beriladi.
			const popCallId = `sip-in-${Date.now()}`;
			refs.popCallId.current = popCallId;
			refs.backendCallId.current = null;
			refs.endReason.current = null;

			const { showCall } = useCallPopStore.getState();

			showCall({
				callId: popCallId,
				direction: "inbound",
				callerNumber: callerUser,
				calleeExtension: config.extension || "",
				startedAt: new Date().toISOString(),
				status: "ringing",
				contact: null,
			});

			sendCallStartWebhook("inbound", callerUser, config.extension)
				.then((id) => {
					if (id) {
						refs.backendCallId.current = id;
					}
				})
				.catch(() => {
					/* Ignore webhook failure on call start */
				});

			setupSessionHandlers(invitation);

			if (document.visibilityState !== "visible") {
				showCallNotification(callerName, callerUser, () => window.focus());
			}

			setTimeout(() => {
				if (
					refs.currentSession.current === invitation &&
					invitation.state === SessionState.Initial
				) {
					// Panel ham yopilishi kerak: avval faqat SIP holati bo'shatilardi va
					// panel "Kutish: N s" hisobini abadiy oshirib turardi.
					refs.endReason.current = "noAnswer";
					finishCallPop(refs, 0);
					invitation.reject().catch(() => {
						/* Ignore rejection error if session is already closed */
					});
					endCall();
				}
			}, 45000);
		},
		[refs, config.extension, endCall, playRingtone, sendCallStartWebhook, setupSessionHandlers]
	);

	return { setupSessionHandlers, handleIncomingCall };
}
