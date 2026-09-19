import { useCallback, useRef } from "react";

/**
 * Audio feedback (ringtone) va remote media boshqarish hook.
 * Ringtone oscillyatsiyasi va remote audio stream.
 */
export function useSipAudio() {
	const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
	// Konsultatsiya (attended transfer) uchun ikkinchi sink: bitta <audio> element
	// ikki MediaStream'ni bir vaqtda o'ynatolmaydi.
	const consultationAudioRef = useRef<HTMLAudioElement | null>(null);
	const audioContextRef = useRef<AudioContext | null>(null);
	const ringtoneOscillatorRef = useRef<OscillatorNode | null>(null);

	const playRingtone = useCallback(() => {
		if (ringtoneOscillatorRef.current) {
			return;
		}
		try {
			// biome-ignore lint/suspicious/noExplicitAny: webkitAudioContext fallback
			const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
			audioContextRef.current = ctx;
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();

			osc.type = "sine";
			osc.frequency.setValueAtTime(440, ctx.currentTime);
			osc.frequency.setTargetAtTime(480, ctx.currentTime + 0.1, 0.2);

			gain.gain.setValueAtTime(0.1, ctx.currentTime);
			gain.gain.setTargetAtTime(0, ctx.currentTime + 1.8, 0.2);

			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.start();
			ringtoneOscillatorRef.current = osc;

			const interval = setInterval(() => {
				if (osc.onended === null) {
					osc.frequency.setValueAtTime(440, ctx.currentTime);
					gain.gain.setValueAtTime(0.1, ctx.currentTime);
					gain.gain.setTargetAtTime(0, ctx.currentTime + 1.8, 0.2);
				}
			}, 2000);

			// biome-ignore lint/suspicious/noExplicitAny: storing interval ref
			(osc as any)._interval = interval;
		} catch {
			// Audio feedback not supported
		}
	}, []);

	const stopRingtone = useCallback(() => {
		if (ringtoneOscillatorRef.current) {
			try {
				// biome-ignore lint/suspicious/noExplicitAny: clearing stored interval
				const osc = ringtoneOscillatorRef.current as any;
				if (osc._interval) {
					clearInterval(osc._interval);
				}
				osc.stop();
				osc.disconnect();
			} catch {
				// already stopped
			}
			ringtoneOscillatorRef.current = null;
		}
		if (audioContextRef.current) {
			audioContextRef.current.close().catch(() => {
				// ignore close errors
			});
			audioContextRef.current = null;
		}
	}, []);

	const getRemoteAudioRef = useCallback(() => remoteAudioRef, []);

	return {
		remoteAudioRef,
		consultationAudioRef,
		getRemoteAudioRef,
		playRingtone,
		stopRingtone,
	};
}
