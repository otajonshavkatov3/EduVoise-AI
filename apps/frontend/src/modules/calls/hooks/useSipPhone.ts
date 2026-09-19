import { useSipStore } from "../store/sip.store";
import { useSipCallActions } from "./sip/useSipCallActions";
import { useSipConnection } from "./sip/useSipConnection";
import { useSipRefs } from "./sip/useSipRefs";
import { useSipSession } from "./sip/useSipSession";
import { useSipTransfer } from "./sip/useSipTransfer";
import { useSipAudio } from "./useSipAudio";
import { useSipNetworkMonitor } from "./useSipNetworkMonitor";
import { useSipWebhooks } from "./useSipWebhooks";

export function useSipPhone() {
	const {
		config,
		connectionStatus,
		activeCall,
		isRegistered,
		errorMessage,
		operatorStatus,
		extension,
		hasSoftphone,
		webExtension,
		deskExtension,
		desiredOnline,
		setConfig,
		setOperatorStatus,
		reportStatus,
		fetchOperatorProfile,
		fetchSipCredentials,
		endCall,
	} = useSipStore();

	const refs = useSipRefs();

	const { playRingtone, stopRingtone, remoteAudioRef, consultationAudioRef } = useSipAudio();
	const { startNetworkMonitoring, stopNetworkMonitoring } = useSipNetworkMonitor();
	const { uploadRecording, sendCallStartWebhook, sendCallEndWebhook } = useSipWebhooks();

	// Bind refs correctly
	refs.remoteAudio = remoteAudioRef;
	refs.consultationAudio = consultationAudioRef;

	const { setupSessionHandlers, handleIncomingCall } = useSipSession({
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
	});

	const { connect, disconnect } = useSipConnection({
		refs,
		config,
		setConfig,
		handleIncomingCall,
		endCall,
	});

	const { makeCall, answerCall, rejectCall, hangup, sendDTMF, toggleMute, toggleHold } =
		useSipCallActions({
			refs,
			config,
			isRegistered,
			playRingtone,
			stopRingtone,
			setupSessionHandlers,
			sendCallStartWebhook,
			endCall,
		});

	const { blindTransfer, startConsultation, cancelConsultation, completeAttendedTransfer } =
		useSipTransfer({
			refs,
			config,
			endCall,
		});

	return {
		config,
		connectionStatus,
		activeCall,
		isRegistered,
		errorMessage,
		operatorStatus,
		extension,
		hasSoftphone,
		webExtension,
		deskExtension,
		desiredOnline,
		connect,
		disconnect,
		makeCall,
		answerCall,
		rejectCall,
		hangup,
		sendDTMF,
		toggleMute,
		toggleHold,
		setConfig,
		setOperatorStatus,
		reportStatus,
		fetchOperatorProfile,
		fetchSipCredentials,
		blindTransfer,
		startConsultation,
		cancelConsultation,
		completeAttendedTransfer,
		// Ovoz sink'lari SipPhoneProvider JSX'ida <audio ref=...> ga beriladi.
		remoteAudioRef,
		consultationAudioRef,
	};
}
