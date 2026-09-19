import { getClientEnv } from "@shared/env";
import { useEffect, useRef } from "react";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { getStoredAccessToken } from "@/shared/utils/token";

export type WsMessage = Record<string, unknown> & { type: string };

interface UseWebSocketOptions {
	/** Called every time a valid JSON message arrives from the server. */
	onMessage: (msg: WsMessage) => void;
	/** Whether the socket should be active (opened). Pass `false` to skip. */
	enabled?: boolean;
	/** Reconnect delay in ms (default: 3000). */
	reconnectDelay?: number;
	/** Called when connection status changes. */
	onStatusChange?: (status: "connecting" | "connected" | "disconnected") => void;
}

/**
 * Opens a WebSocket connection to /ws, sends the JWT auth token as a query param,
 * re-connects automatically after disconnect (with exponential back-off up to 30 s).
 *
 * Token har (qayta) ulanishda localStorage'dan qaytadan o'qiladi, shuning uchun
 * `apiClient` tokenni yangilagach keyingi ulanish yangi tokenni oladi. Bundan
 * tashqari, socket `onopen` ga yetmasdan yopilsa (ehtimol token muddati o'tgan),
 * keyingi urinishdan oldin token `/auth/refresh` orqali yangilanadi — aks holda
 * bekor bo'lgan token bilan cheksiz aylanib, jonli hodisalar yo'qolardi.
 */
export function useWebSocket({
	onMessage,
	enabled = true,
	reconnectDelay = 3000,
	onStatusChange,
}: UseWebSocketOptions) {
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const delayRef = useRef(reconnectDelay);
	const onMessageRef = useRef(onMessage);
	const onStatusChangeRef = useRef(onStatusChange);

	// Keep callback stable without triggering re-connection
	useEffect(() => {
		onMessageRef.current = onMessage;
		onStatusChangeRef.current = onStatusChange;
	}, [onMessage, onStatusChange]);

	useEffect(() => {
		if (!enabled) {
			return;
		}

		let destroyed = false;

		function connect() {
			if (destroyed) {
				return;
			}

			const token = getStoredAccessToken();
			if (!token) {
				return;
			}

			const env = getClientEnv();
			// Convert http(s)://host to ws(s)://host and ensure /api prefix
			const apiBase = env.VITE_API_URL.endsWith("/")
				? env.VITE_API_URL.slice(0, -1)
				: env.VITE_API_URL;
			const wsBase = `${apiBase}/api`.replace(/^http/, "ws");
			const wsPath = API_ENDPOINTS.WS;

			// Ensure we don't have double slashes if wsBase ends with / or wsPath starts with /
			const baseUrl = wsBase.endsWith("/") ? wsBase.slice(0, -1) : wsBase;
			const path = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;

			const url = `${baseUrl}${path}?token=${encodeURIComponent(token)}`;

			// console.log("[WebSocket] Connecting to:", url.split("?")[0]);
			onStatusChangeRef.current?.("connecting");
			const ws = new WebSocket(url);
			wsRef.current = ws;

			// Shu urinish muvaffaqiyatli ulanib bo'lganmi? `onopen` ga yetmay
			// yopilsa token eskirgan bo'lishi mumkin — keyin yangilaymiz.
			let opened = false;

			ws.onopen = () => {
				// console.log("[WebSocket] Connected");
				opened = true;
				onStatusChangeRef.current?.("connected");
				delayRef.current = reconnectDelay; // reset back-off on success
			};

			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data as string) as WsMessage;
					onMessageRef.current(data);
				} catch {
					// ignore malformed frames
				}
			};

			ws.onclose = () => {
				wsRef.current = null;
				onStatusChangeRef.current?.("disconnected");
				if (destroyed) {
					return;
				}

				// Hech ulanmay yopilsa token yangilanadi. Ulanib bo'lib keyin uzilgan
				// bo'lsa (tarmoq uzilishi) token hali yaroqli — behuda yangilamaymiz.
				const refreshFirst = !opened;

				reconnectTimer.current = setTimeout(() => {
					reconnectTimer.current = null;
					delayRef.current = Math.min(delayRef.current * 1.5, 30_000);

					if (refreshFirst) {
						// `refresh()` yangi tokenni localStorage'ga yozadi; `connect()`
						// uni o'qiydi. Xato bo'lsa ham qayta urinamiz — server vaqtincha
						// yiqilgan bo'lishi mumkin; logout'ni oddiy API 401 oqimi hal qiladi.
						useAuthStore
							.getState()
							.refresh()
							.finally(() => {
								if (!destroyed) {
									connect();
								}
							});
					} else {
						connect();
					}
				}, delayRef.current);
			};

			ws.onerror = () => {
				ws.close();
			};
		}

		connect();

		return () => {
			destroyed = true;
			if (reconnectTimer.current) {
				clearTimeout(reconnectTimer.current);
			}
			wsRef.current?.close();
			wsRef.current = null;
		};
	}, [enabled, reconnectDelay]);

	// Ataylab hech narsa qaytarilmaydi: kanal bir tomonlama. Avval bu yerda
	// `sendMessage` bor edi, uni esa hech kim chaqirmasdi. Mijozdan serverga
	// xabar yuborish kerak bo'lsa, uni qaytadan qo'shish bir necha qator ish.
}
