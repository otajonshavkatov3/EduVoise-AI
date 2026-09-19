/**
 * Web Telefon - SIP Konfiguratsiyasi
 *
 * Qiymatlar quyidagi tartibda o'qiladi:
 *   1. localStorage ("sip_config") — Sozlamalar sahifasida saqlangan qiymatlar
 *   2. Vite muhit o'zgaruvchilari (build vaqtida)
 *   3. Quyidagi standart Asterisk qiymatlari
 *
 * Muhit o'zgaruvchilari (.env fayliga qo'shiladi, VITE_ prefiksi majburiy):
 *   VITE_SIP_WS_URL       To'liq WebSocket manzili, masalan ws://localhost:8088/ws
 *                         yoki wss://pbx.example.com:8089/ws
 *   VITE_SIP_EXTENSION    Ichki raqam (extension), masalan 101
 *   VITE_SIP_PASSWORD     Shu extension uchun SIP paroli
 *   VITE_SIP_REALM        SIP domeni (realm). Berilmasa VITE_SIP_WS_URL hosti
 *                         ishlatiladi. Realm ham transport hosti sifatida
 *                         ishlatilganini yodda tuting — boshqa domen kerak
 *                         bo'lsa u shu WebSocket serverga yo'naltirilishi shart.
 *   VITE_SIP_AUTO_CONNECT "true" bo'lsa sahifa yuklanganda avtomatik ulanadi.
 *                         Standart holat — false (pastdagi izohga qarang).
 *
 * MUHIM — brauzerdan qo'ng'iroq qilish "opt-in":
 * Asterisk WebSocket orqali SIP qabul qilishi uchun `res_pjsip_transport_websocket`
 * moduli yuklangan bo'lishi, pjsip.conf'da `transport-wss` (yoki transport-ws)
 * transporti e'lon qilinishi va WebRTC uchun DTLS sertifikatlari
 * (dtls_cert_file / dtls_private_key) sozlangan bo'lishi kerak. Bundan tashqari
 * brauzer `wss://` dan boshqasini (localhost'dan tashqari) rad etadi.
 * Shu sabab standart holatda `autoConnect: false` — aks holda sozlanmagan
 * hostda sahifa o'lik socketga cheksiz qayta ulanishga urinadi.
 * Sozlamalar → "Web Telefon (SIP)" sahifasidan qo'lda yoqiladi.
 */

export interface SipConfig {
	/** SIP server IP/domeni. Ham WebSocket hosti, ham SIP URI domeni (realm). */
	serverIp: string;
	/** WebSocket port */
	wsPort: string;
	/** WebSocket protokoli: 'ws' yoki 'wss' */
	wsProtocol: "ws" | "wss";
	/** WebSocket yo'li. Asterisk http.conf va FreePBX'da bu "/ws". */
	wsPath: string;
	/** SIP extension (ichki raqam) */
	extension: string;
	/** SIP parol */
	password: string;
	/** Ko'rsatiladigan nom */
	displayName: string;
	/** Registratsiya muddati (sekund) */
	registerExpires: number;
	/** Debug rejimi */
	debug: boolean;
	/** ICE serverlari (WebRTC uchun) */
	iceServers: RTCIceServer[];
	/** Audio sozlamalari */
	audio: MediaTrackConstraints;
	/** Avtomatik ulanish (standart: false) */
	autoConnect: boolean;
}

interface ParsedWsUrl {
	wsProtocol: "ws" | "wss";
	host: string;
	wsPort: string;
	wsPath: string;
}

/** Yangi Asterisk (docker: callcenter-asterisk, ARI/HTTP porti 8088). */
const FALLBACK_WS: ParsedWsUrl = {
	wsProtocol: "ws",
	host: "localhost",
	wsPort: "8088",
	wsPath: "/ws",
};

const FALLBACK_EXTENSION = "101";

/**
 * Vite muhit o'zgaruvchisini xavfsiz o'qish.
 * Bo'sh qiymat berilmagan deb hisoblanadi.
 */
function readEnv(key: string): string | undefined {
	const source =
		typeof import.meta !== "undefined" && import.meta.env
			? (import.meta.env as Record<string, unknown>)
			: undefined;
	const value = source?.[key];
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** "ws://host:port/path" ni tarkibiy qismlarga ajratadi. */
function parseWsUrl(raw: string | undefined): ParsedWsUrl | null {
	if (!raw) {
		return null;
	}
	try {
		const url = new URL(raw);
		if (url.protocol !== "ws:" && url.protocol !== "wss:") {
			return null;
		}
		const wsProtocol = url.protocol === "wss:" ? "wss" : "ws";
		const wsPort = url.port || (wsProtocol === "wss" ? "443" : "80");
		const wsPath = url.pathname && url.pathname !== "/" ? url.pathname : "/ws";
		return { wsProtocol, host: url.hostname, wsPort, wsPath };
	} catch {
		// Noto'g'ri manzil — standart qiymatlarga qaytamiz
		return null;
	}
}

const ENV_WS = parseWsUrl(readEnv("VITE_SIP_WS_URL")) ?? FALLBACK_WS;
const ENV_EXTENSION = readEnv("VITE_SIP_EXTENSION") ?? FALLBACK_EXTENSION;

/** Standart SIP konfiguratsiya (muhit o'zgaruvchilaridan to'ldiriladi) */
export const DEFAULT_SIP_CONFIG: SipConfig = {
	serverIp: readEnv("VITE_SIP_REALM") ?? ENV_WS.host,
	wsPort: ENV_WS.wsPort,
	wsProtocol: ENV_WS.wsProtocol,
	wsPath: ENV_WS.wsPath,
	extension: ENV_EXTENSION,
	password: readEnv("VITE_SIP_PASSWORD") ?? "",
	displayName: `Extension ${ENV_EXTENSION}`,
	registerExpires: 300,
	debug: true,
	iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
	audio: {
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
	},
	autoConnect: readEnv("VITE_SIP_AUTO_CONNECT")?.toLowerCase() === "true",
};

/**
 * Backend bergan per-operator SIP hisob ma'lumotlarini mavjud `SipConfig`
 * shakliga o'tkazadi (`GET /operator-profiles/me/sip`).
 *
 * `sipUsername` ham register URI foydalanuvchisi (`extension`), ham SIP auth
 * login sifatida ishlatiladi — `useSipConnection` `cfg.extension` ni ikkala
 * joyda ham qo'llaydi. `serverIp` realm'dan olinadi (SIP URI domeni); bu
 * deploymentda realm va WebSocket hosti bir xil, shu sababli transport ham
 * to'g'ri bo'ladi. Transport porti/protokoli/yo'li esa `wsUrl` dan ajratiladi.
 *
 * `autoConnect: true` — endpoint muvaffaqiyatli javob bergan operator haqiqiy
 * softfonga ega, ya'ni online bo'lganda avtomatik ulanishi kerak (VITE_SIP_*
 * env bayrog'iga bog'liq emas). Noto'g'ri `wsUrl` bo'lsa `null` qaytadi va
 * chaqiruvchi registratsiya qilmaydi.
 */
export function sipConfigFromCredentials(creds: {
	sipUsername: string;
	sipPassword: string;
	wsUrl: string;
	realm: string;
	webExtension?: string;
}): Partial<SipConfig> | null {
	const ws = parseWsUrl(creds.wsUrl);
	if (!ws) {
		return null;
	}
	const realm = creds.realm.trim().length > 0 ? creds.realm.trim() : ws.host;
	return {
		serverIp: realm,
		wsProtocol: ws.wsProtocol,
		wsPort: ws.wsPort,
		wsPath: ws.wsPath,
		extension: creds.sipUsername,
		password: creds.sipPassword,
		displayName: creds.webExtension ? `Operator ${creds.webExtension}` : creds.sipUsername,
		autoConnect: true,
	};
}

/** SIP konfiguratsiyani WebSocket URL ga aylantirish */
export function buildWsUrl(config: SipConfig): string {
	const path = config.wsPath || "/ws";
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return `${config.wsProtocol}://${config.serverIp}:${config.wsPort}${normalizedPath}`;
}

/** SIP URI yaratish */
export function buildSipUri(extension: string, serverIp: string): string {
	return `sip:${extension}@${serverIp}`;
}

/**
 * Sahifa yuklanganda avtomatik ulanish mumkinmi?
 * Sozlanmagan hostda o'lik socketga cheksiz qayta ulanishni oldini oladi.
 */
export function shouldAutoConnect(config: SipConfig): boolean {
	return (
		config.autoConnect && config.serverIp.trim().length > 0 && config.extension.trim().length > 0
	);
}

/**
 * LocalStorage dan SIP konfiguratsiyani o'qish
 * Agar mavjud bo'lmasa, standart konfiguratsiya qaytaradi
 */
export function loadSipConfig(): SipConfig {
	try {
		const stored = localStorage.getItem("sip_config");
		if (stored) {
			return { ...DEFAULT_SIP_CONFIG, ...JSON.parse(stored) };
		}
	} catch {
		// Silent fail
	}
	return { ...DEFAULT_SIP_CONFIG };
}

/** SIP konfiguratsiyani LocalStorage ga saqlash */
export function saveSipConfig(config: Partial<SipConfig>): void {
	try {
		const current = loadSipConfig();
		const updated = { ...current, ...config };
		localStorage.setItem("sip_config", JSON.stringify(updated));
	} catch {
		// Silent fail
	}
}
