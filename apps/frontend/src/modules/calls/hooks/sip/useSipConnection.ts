import { useCallback, useRef } from "react";
import {
	Inviter,
	Registerer,
	RegistererState,
	SessionState,
	UserAgent,
	type UserAgentOptions,
} from "sip.js";
import type { TransportOptions } from "sip.js/lib/platform/web";
import type { SipConfig } from "../../config/sip.config";
import { buildSipUri, buildWsUrl, saveSipConfig } from "../../config/sip.config";
import { useSipStore } from "../../store/sip.store";
import type { SipRefs } from "./useSipRefs";

interface UseSipConnectionProps {
	refs: SipRefs;
	config: SipConfig;
	setConfig: (config: Partial<SipConfig>) => void;
	handleIncomingCall: (invitation: any) => void;
	endCall: () => void;
}

/**
 * Reconnect backoff: 1s, 2s, 4s, 8s, 16s, then every 30s.
 *
 * The old code retried every second forever. Each retry opened a WebSocket to
 * Asterisk's HTTP server, and because the retries overlapped, most of those
 * sockets were orphaned rather than closed. Asterisk counts every one against
 * http.conf `sessionlimit`, and ARI is served by the SAME HTTP server - so a
 * reconnect loop in a browser tab took the entire telephony platform down.
 * Measured after one Asterisk restart with a few CRM tabs open: 264 WebSocket
 * sessions accepted, 65 closed, the 200-session limit exceeded 324 times, and
 * every call to 900 failing at the ARI answer - including calls from MicroSIP,
 * which has nothing to do with the browser.
 *
 * Retrying does not stop, because an operator who leaves the dashboard open
 * across an Asterisk restart must get their phone back without touching
 * anything. It just stops being a flood.
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function reconnectDelay(attempt: number): number {
	return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5));
}

/**
 * Close a UserAgent's socket, whatever state it is in.
 *
 * `stop()` rejects if the WebSocket is still CONNECTING, and the old code
 * swallowed that and moved on - leaving a socket Asterisk still counted. The
 * explicit transport disconnect is the belt to that braces.
 */
async function shutdownUserAgent(ua: UserAgent): Promise<void> {
	try {
		await ua.stop();
	} catch {
		/* Already stopping, or never finished starting. */
	}

	try {
		await ua.transport.disconnect();
	} catch {
		/* Transport was never up, or is already closed. */
	}
}

export function useSipConnection({
	refs,
	config,
	setConfig,
	handleIncomingCall,
	endCall,
}: UseSipConnectionProps) {
	const { setConnectionStatus, setRegistered, setError } = useSipStore();

	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectAttempt = useRef(0);
	/** Set while a connect is running, so a second one waits instead of racing. */
	const connectInFlight = useRef<Promise<void> | null>(null);
	/**
	 * Bumped for every UserAgent we build. A UA whose generation is stale has been
	 * replaced, and must not be allowed to schedule reconnects of its own - that
	 * fan-out is what turned one dropped connection into a flood.
	 */
	const generation = useRef(0);
	/**
	 * Indirection so a retry always runs the latest `connect`.
	 *
	 * A timer armed inside one render must not pin that render's closure - the
	 * config it captured may already be stale by the time it fires.
	 */
	const connectRef = useRef<(overrideConfig?: Partial<SipConfig>) => Promise<void>>(() =>
		Promise.resolve()
	);

	const cancelReconnect = useCallback(() => {
		if (reconnectTimer.current !== null) {
			clearTimeout(reconnectTimer.current);
			reconnectTimer.current = null;
		}
	}, []);

	/**
	 * Queue one retry for the UA identified by `forGeneration`.
	 *
	 * At most one timer exists at a time, and a superseded generation is refused,
	 * so retries can never overlap or multiply however many times this is called.
	 */
	const scheduleReconnect = useCallback(
		(forGeneration: number) => {
			if (generation.current !== forGeneration) {
				return;
			}

			// Qayta ulanish NIYAT bilan boshqariladi (`desiredOnline`), backend
			// "operatorStatus" bilan emas: softfon registratsiyasi vaqtincha
			// yo'qolganda presence "offline" ga tushishi mumkin, lekin operator
			// hali ham online bo'lishni xohlaydi va telefon qayta ulanishi shart.
			if (!useSipStore.getState().desiredOnline) {
				return;
			}

			const delay = reconnectDelay(reconnectAttempt.current);

			reconnectAttempt.current += 1;
			cancelReconnect();

			reconnectTimer.current = setTimeout(() => {
				reconnectTimer.current = null;

				if (useSipStore.getState().desiredOnline) {
					connectRef.current().catch(() => {
						/* connect() reports its own failures through the store. */
					});
				}
			}, delay);
		},
		[cancelReconnect]
	);

	const disconnect = useCallback(async () => {
		cancelReconnect();
		// Retire whatever UA is current: its onDisconnect must not fire a reconnect
		// after the operator explicitly went offline.
		generation.current += 1;

		try {
			if (refs.currentSession.current) {
				const session = refs.currentSession.current;
				if (
					session.state === SessionState.Established ||
					session.state === SessionState.Establishing
				) {
					if (session instanceof Inviter) {
						await session.cancel().catch(() => {
							/* Ignore cancel error if session already ended */
						});
					} else {
						await session.bye().catch(() => {
							/* Ignore bye error if session already ended */
						});
					}
				}
				refs.currentSession.current = null;
				endCall();
			}

			if (refs.registerer.current) {
				await refs.registerer.current.unregister().catch(() => {
					/* Ignore unregister error */
				});
				refs.registerer.current = null;
			}

			if (refs.userAgent.current) {
				const ua = refs.userAgent.current;
				// Clear the ref first: nothing may reach a UA that is going away, and
				// this is also what stops a later connect from re-entering disconnect.
				refs.userAgent.current = null;
				await shutdownUserAgent(ua);
			}

			setConnectionStatus("disconnected");
			setRegistered(false);
			setError(null);
		} catch {
			/* Ignore disconnect errors as we are already resetting the state */
		}
	}, [refs, endCall, cancelReconnect, setConnectionStatus, setRegistered, setError]);

	const openConnection = useCallback(
		async (overrideConfig?: Partial<SipConfig>) => {
			cancelReconnect();

			if (refs.userAgent.current) {
				await disconnect();
			}

			const cfg = overrideConfig ? { ...config, ...overrideConfig } : config;

			if (overrideConfig) {
				setConfig(overrideConfig);
				saveSipConfig(overrideConfig);
			}

			const wsUrl = buildWsUrl(cfg);
			const sipUri = buildSipUri(cfg.extension, cfg.serverIp);

			setConnectionStatus("connecting");
			setError(null);

			try {
				const uri = UserAgent.makeURI(sipUri);
				if (!uri) {
					throw new Error("SIP URI yaratishda xato");
				}

				const transportOptions: TransportOptions = { server: wsUrl };

				const userAgentOptions: UserAgentOptions = {
					uri,
					transportOptions,
					authorizationUsername: cfg.extension,
					authorizationPassword: cfg.password,
					displayName: cfg.displayName || `Extension ${cfg.extension}`,
					logLevel: cfg.debug ? "debug" : "error",
					sessionDescriptionHandlerFactoryOptions: {
						iceGatheringTimeout: 300,
						peerConnectionConfiguration: {
							iceServers: cfg.iceServers,
							rtcpMuxPolicy: "negotiate" as RTCRtcpMuxPolicy,
							bundlePolicy: "balanced" as RTCBundlePolicy,
						},
					},
					delegate: { onInvite: handleIncomingCall },
				};

				const ua = new UserAgent(userAgentOptions);
				const myGeneration = generation.current + 1;

				generation.current = myGeneration;
				refs.userAgent.current = ua;

				ua.transport.onConnect = () => {
					reconnectAttempt.current = 0;
					setConnectionStatus("connected");
				};
				ua.transport.onDisconnect = () => {
					// Ignore a UA we have already replaced, otherwise every generation
					// keeps scheduling retries and they multiply instead of backing off.
					if (generation.current !== myGeneration) {
						return;
					}

					setConnectionStatus("disconnected");
					setRegistered(false);
					scheduleReconnect(myGeneration);
				};

				await ua.start();

				const reg = new Registerer(ua, { expires: cfg.registerExpires || 300 });
				reg.stateChange.addListener((state: RegistererState) => {
					switch (state) {
						case RegistererState.Registered:
							setConnectionStatus("registered");
							setRegistered(true);
							setError(null);
							break;
						case RegistererState.Unregistered:
						case RegistererState.Terminated:
							setConnectionStatus("disconnected");
							setRegistered(false);
							break;
					}
				});

				refs.registerer.current = reg;
				await reg.register();
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : "Ulanishda xato yuz berdi";

				setConnectionStatus("error");
				setError(msg);

				// A socket that never finished connecting emits no onDisconnect, so
				// without this the phone stays dead until the operator notices. The UA
				// is discarded rather than left in the ref: keeping a half-started one
				// is what leaked sockets.
				const failed = refs.userAgent.current;

				if (failed !== null) {
					refs.userAgent.current = null;
					await shutdownUserAgent(failed);
				}

				scheduleReconnect(generation.current);
			}
		},
		[
			refs,
			config,
			disconnect,
			handleIncomingCall,
			cancelReconnect,
			scheduleReconnect,
			setConfig,
			setConnectionStatus,
			setError,
			setRegistered,
		]
	);

	/**
	 * Public entry point. Serialises: two overlapping connects each build a
	 * UserAgent and the second overwrites the ref, so the first one's WebSocket is
	 * never closed. That single race is what exhausted Asterisk's HTTP session
	 * limit and took ARI - and therefore every call - down with it.
	 */
	const connect = useCallback(
		async (overrideConfig?: Partial<SipConfig>) => {
			if (connectInFlight.current !== null) {
				return connectInFlight.current;
			}

			const attempt = openConnection(overrideConfig);

			connectInFlight.current = attempt;

			try {
				await attempt;
			} finally {
				connectInFlight.current = null;
			}
		},
		[openConnection]
	);

	connectRef.current = connect;

	return { connect, disconnect };
}
