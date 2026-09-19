import { useCallback, useRef } from "react";
import type { Session } from "sip.js";
import { useSipStore } from "../store/sip.store";

// biome-ignore lint/suspicious/noExplicitAny: SIP.js SDH internals not fully typed
type SdhAny = any;

/**
 * WebRTC tarmoq sifatini monitoring qilish hook.
 */
export function useSipNetworkMonitor() {
	const networkStatsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const { setNetworkQuality } = useSipStore();

	const startNetworkMonitoring = useCallback(
		(session: Session) => {
			if (networkStatsIntervalRef.current) {
				clearInterval(networkStatsIntervalRef.current);
			}

			networkStatsIntervalRef.current = setInterval(async () => {
				const sdh = session.sessionDescriptionHandler as SdhAny;
				const pc = sdh?.peerConnection as RTCPeerConnection;
				if (!pc) {
					return;
				}

				try {
					const stats = await pc.getStats();
					stats.forEach((report) => {
						if (report.type === "remote-inbound-rtp") {
							const jitter = report.jitter || 0;
							const rtt = report.roundTripTime || 0;
							setNetworkQuality({ jitter, rtt });
						}
					});
				} catch {
					// stats polling error
				}
			}, 5000);
		},
		[setNetworkQuality]
	);

	const stopNetworkMonitoring = useCallback(() => {
		if (networkStatsIntervalRef.current) {
			clearInterval(networkStatsIntervalRef.current);
			networkStatsIntervalRef.current = null;
		}
	}, []);

	return { startNetworkMonitoring, stopNetworkMonitoring };
}
