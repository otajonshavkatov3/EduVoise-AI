import { create } from "zustand";
import { operatorService } from "@/modules/operators/services/operator.service";
import type { OperatorStatus } from "../../operators/types";
import type { SipConfig } from "../config/sip.config";
import { loadSipConfig, sipConfigFromCredentials } from "../config/sip.config";

/**
 * Operatorning "online bo'lish" niyati — shu tab doirasida, sahifa yangilanganda
 * ham saqlanadi.
 *
 * Presence registratsiyaga bog'langan: yopilayotgan sahifa "offline" deb xabar
 * beradi (to'g'ri — uning telefoni yo'qoladi). Shu sababli keyingi yuklanishda
 * niyatni server holatidan o'qish har doim "offline" ni topardi va oddiy
 * yangilashdan keyin softfon ulanmay qolardi ("SIP ULANMAGAN") — operator uni
 * qo'lda qayta yoqmaguncha. sessionStorage aynan tab umricha yashaydi: yangilash
 * niyatni tiklaydi, yangi tab yoki brauzer sessiyasi esa server holatidan
 * boshlaydi. Operator profili bo'yicha kalitlangan — shu tabda boshqa
 * foydalanuvchi kirsa, niyat unga o'tmaydi.
 */
const ONLINE_INTENT_KEY = "sip_online_intent";

function readOnlineIntent(profileId: string): boolean | null {
	try {
		const raw = sessionStorage.getItem(ONLINE_INTENT_KEY);
		if (raw === null) {
			return null;
		}
		const saved = JSON.parse(raw) as { profileId?: unknown; online?: unknown };
		return saved.profileId === profileId && typeof saved.online === "boolean" ? saved.online : null;
	} catch {
		return null;
	}
}

function writeOnlineIntent(profileId: string | null, online: boolean): void {
	if (profileId === null) {
		return;
	}
	try {
		sessionStorage.setItem(ONLINE_INTENT_KEY, JSON.stringify({ profileId, online }));
	} catch {
		// Saqlash bloklangan: niyat shunchaki yangilashdan keyin tiklanmaydi.
	}
}

/** SIP ulanish holatlari */
export type SipConnectionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "registered"
	| "error";

/** SIP qo'ng'iroq holatlari */
export type SipCallStatus =
	| "idle"
	| "calling"
	| "ringing"
	| "early_media"
	| "established"
	| "terminating"
	| "terminated";

/** SIP qo'ng'iroq yo'nalishi */
export type SipCallDirection = "inbound" | "outbound";

/** Hozirgi qo'ng'iroq ma'lumotlari */
export interface SipActiveCall {
	id: string;
	direction: SipCallDirection;
	remoteNumber: string;
	remoteDisplayName: string;
	status: SipCallStatus;
	startTime: number | null;
	isMuted: boolean;
	isOnHold: boolean;
}

interface SipState {
	/** SIP konfiguratsiya */
	config: SipConfig;
	/** Ulanish holati */
	connectionStatus: SipConnectionStatus;
	/** Joriy qo'ng'iroq */
	activeCall: SipActiveCall | null;
	/** Xato xabari */
	errorMessage: string | null;
	/** Registratsiya holati */
	isRegistered: boolean;
	/** Operator holati (online, offline, pause, busy) */
	operatorStatus: OperatorStatus;
	/**
	 * Foydalanuvchida operator profili bor-yo'qligi.
	 * `null` — hali aniqlanmagan (profil so'rovi tugamagan). Bu farq muhim:
	 * profili yo'q foydalanuvchiga soxta "Online" ko'rsatilmasligi kerak.
	 */
	hasOperatorProfile: boolean | null;
	/** Ichki raqam (extension) */
	extension: string | null;
	/** Operator profili id si — online niyatini shu tab uchun saqlash kaliti. */
	operatorProfileId: string | null;
	/**
	 * Operatorda brauzer softfoni bor-yo'qligi (`/operator-profiles/me/sip`).
	 * `null` — hali so'ralmagan; `false` — 404/409 (profil yoki brauzer jufti
	 * yo'q), registratsiya qilinmaydi; `true` — hisob ma'lumotlari olindi.
	 */
	hasSoftphone: boolean | null;
	/** Operatorning stol extension'i (`me/sip` dan). */
	deskExtension: string | null;
	/** Operatorning brauzer softfon extension'i (`me/sip` dan). */
	webExtension: string | null;
	/**
	 * Operator online bo'lishni XOHLAYDImi (mahalliy niyat). Ulanish/qayta ulanish
	 * aynan shu bilan boshqariladi; backendga esa faqat softfon haqiqatan
	 * registratsiyadan o'tgach "online" deb xabar beriladi. Ikkisini ajratish shart:
	 * registratsiyasiz "online" deb xabar berish AI uzatgan qo'ng'iroqni hech narsa
	 * jiringlamaydigan telefonga yo'naltiradi.
	 */
	desiredOnline: boolean;
	/** Tarmoq sifati (jitter, rtt) */
	networkQuality: { jitter: number; rtt: number } | null;
}

interface SipActions {
	/** Konfiguratsiyani yangilash */
	setConfig: (config: Partial<SipConfig>) => void;
	/** Ulanish holatini o'zgartirish */
	setConnectionStatus: (status: SipConnectionStatus) => void;
	/** Xato xabarini yozish */
	setError: (message: string | null) => void;
	/** Registratsiya holatini o'zgartirish */
	setRegistered: (registered: boolean) => void;

	// Qo'ng'iroq bilan bog'liq actionlar
	/** Chiquvchi qo'ng'iroq boshlandi */
	startOutgoingCall: (number: string) => void;
	/** Kiruvchi qo'ng'iroq keldi */
	startIncomingCall: (number: string, displayName: string) => void;
	/** Qo'ng'iroq holati o'zgarishi */
	setCallStatus: (status: SipCallStatus) => void;
	/** Qo'ng'iroq tugadi */
	endCall: () => void;
	/** Mute holati o'zgarishi */
	setMuted: (muted: boolean) => void;
	/** Hold holati o'zgarishi */
	setOnHold: (onHold: boolean) => void;
	/** Tarmoq sifatini o'zgartirish */
	setNetworkQuality: (quality: { jitter: number; rtt: number } | null) => void;
	/** Holatni tozalash */
	reset: () => void;
	/**
	 * Operator holatini o'zgartirish (foydalanuvchi amali).
	 * `deferred: true` — "online" so'raldi, lekin softfon hali registratsiyadan
	 * o'tmagani uchun backendga hozircha xabar berilmadi (registratsiyadan so'ng
	 * avtomatik xabar beriladi). Xato bo'lsa yuqoriga uzatiladi.
	 */
	setOperatorStatus: (status: OperatorStatus) => Promise<{ deferred: boolean }>;
	/**
	 * Holatni backendga AVTOMATIK xabar beradi (niyatni — `desiredOnline` ni —
	 * o'zgartirmasdan). Registratsiya paydo bo'lg/yo'qolganda ishlatiladi; xato
	 * jimgina yutiladi, chunki bu foydalanuvchi amali emas.
	 */
	reportStatus: (status: OperatorStatus) => Promise<void>;
	/** Profilni yuklash */
	fetchOperatorProfile: () => Promise<void>;
	/**
	 * Brauzer softfoni uchun per-operator SIP hisob ma'lumotlarini yuklab,
	 * konfiguratsiyaga qo'llaydi. 404/409 da softfon yo'q deb belgilaydi.
	 */
	fetchSipCredentials: () => Promise<void>;
}

export type SipStore = SipState & SipActions;

const initialState: SipState = {
	config: loadSipConfig(),
	connectionStatus: "disconnected",
	activeCall: null,
	errorMessage: null,
	isRegistered: false,
	operatorStatus: "online",
	hasOperatorProfile: null,
	extension: null,
	operatorProfileId: null,
	hasSoftphone: null,
	deskExtension: null,
	webExtension: null,
	desiredOnline: false,
	networkQuality: null,
};

export const useSipStore = create<SipStore>((set, get) => ({
	...initialState,

	setConfig: (config) =>
		set((state) => ({
			config: { ...state.config, ...config },
		})),

	setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

	setError: (errorMessage) => set({ errorMessage }),

	setRegistered: (isRegistered) => set({ isRegistered }),

	startOutgoingCall: (number) =>
		set({
			activeCall: {
				id: `call-${Date.now()}`,
				direction: "outbound",
				remoteNumber: number,
				remoteDisplayName: number,
				status: "calling",
				startTime: null,
				isMuted: false,
				isOnHold: false,
			},
		}),

	startIncomingCall: (number, displayName) =>
		set({
			activeCall: {
				id: `call-${Date.now()}`,
				direction: "inbound",
				remoteNumber: number,
				remoteDisplayName: displayName || number,
				status: "ringing",
				startTime: null,
				isMuted: false,
				isOnHold: false,
			},
		}),

	setCallStatus: (status) =>
		set((state) => {
			if (!state.activeCall) {
				return state;
			}
			return {
				activeCall: {
					...state.activeCall,
					status,
					startTime:
						status === "established" && !state.activeCall.startTime
							? Date.now()
							: state.activeCall.startTime,
				},
			};
		}),

	endCall: () => set({ activeCall: null }),

	setMuted: (isMuted) =>
		set((state) => {
			if (!state.activeCall) {
				return state;
			}
			return {
				activeCall: { ...state.activeCall, isMuted },
			};
		}),

	setOnHold: (isOnHold) =>
		set((state) => {
			if (!state.activeCall) {
				return state;
			}
			return {
				activeCall: { ...state.activeCall, isOnHold },
			};
		}),

	setNetworkQuality: (networkQuality) => set({ networkQuality }),

	reset: () => set(initialState),

	/**
	 * Operator holatini serverda o'zgartiradi (foydalanuvchi amali).
	 *
	 * Xato bo'lsa mahalliy holat O'ZGARTIRILMAYDI va xato yuqoriga uzatiladi:
	 * avval so'rov yiqilsa ham UI yangi holatni ko'rsatib turardi, ya'ni
	 * ma'lumotlar bazasi bilan mos kelmagan soxta holat chiqardi.
	 *
	 * "Online" va softfon bor, lekin hali registratsiyadan o'tmagan bo'lsa —
	 * niyat yoziladi (`desiredOnline`), lekin backendga "online" deb xabar
	 * BERILMAYDI. Provayder registratsiyadan so'ng `reportStatus("online")` bilan
	 * xabar beradi: registratsiyasiz "online" deb ko'rsatish AI uzatgan
	 * qo'ng'iroqni jiringlamaydigan telefonga yuborishdir.
	 */
	setOperatorStatus: async (status: OperatorStatus) => {
		const { hasSoftphone, isRegistered, operatorProfileId } = get();
		set({ desiredOnline: status === "online" });
		writeOnlineIntent(operatorProfileId, status === "online");

		if (status === "online" && hasSoftphone === true && !isRegistered) {
			return { deferred: true };
		}

		const profile = await operatorService.updateMyStatus(status);
		set({
			operatorStatus: profile.currentStatus as OperatorStatus,
			extension: profile.extension ?? null,
			hasOperatorProfile: true,
		});
		return { deferred: false };
	},

	reportStatus: async (status: OperatorStatus) => {
		try {
			const profile = await operatorService.updateMyStatus(status);
			set({
				operatorStatus: profile.currentStatus as OperatorStatus,
				extension: profile.extension ?? null,
				hasOperatorProfile: true,
			});
		} catch {
			// Avtomatik (registratsiya o'zgarishiga bog'liq) xabar — xato
			// foydalanuvchiga ko'rsatilmaydi; keyingi o'zgarishda qayta urinadi.
		}
	},

	fetchOperatorProfile: async () => {
		try {
			const profile = await operatorService.getMeProfile();
			const status = profile.currentStatus as OperatorStatus;
			set({
				operatorStatus: status,
				extension: profile.extension ?? null,
				hasOperatorProfile: true,
				operatorProfileId: profile.id,
				// Shu tabning o'z niyati ustun: yangilashdan keyin server "offline"
				// deydi, chunki uni operator emas, oldingi sahifa chiqib ketayotib
				// yozgan. Niyat bo'lmasa — avvalgi sessiyada online bo'lsa, qayta
				// ulanishni tiklash uchun niyatni ham online qilamiz.
				desiredOnline: readOnlineIntent(profile.id) ?? status === "online",
			});
		} catch {
			// 404 — bu foydalanuvchi operator emas. Holat ko'rsatilmaydi
			// (switcher o'chirilgan holatga o'tadi), xato oynada chiqarilmaydi:
			// supervisor uchun bu odatiy holat.
			set({
				hasOperatorProfile: false,
				extension: null,
				operatorProfileId: null,
				desiredOnline: false,
			});
		}
	},

	fetchSipCredentials: async () => {
		try {
			const creds = await operatorService.getMySipCredentials();
			const partial = sipConfigFromCredentials(creds);
			if (!partial) {
				// wsUrl noto'g'ri — registratsiya qilmaymiz.
				set({ hasSoftphone: false });
				return;
			}
			set((state) => ({
				config: { ...state.config, ...partial },
				hasSoftphone: true,
				deskExtension: creds.deskExtension,
				webExtension: creds.webExtension,
			}));
		} catch {
			// 404 — operator profili yo'q; 409 — brauzer jufti yo'q. Ikkalasida ham
			// softfon yo'q: registratsiya qilinmaydi, VITE_SIP_* zaxira sifatida
			// qoladi. Tarmoq xatosida ham shu sessiyada softfonsiz qolamiz
			// (sahifani yangilash qayta so'raydi).
			set({ hasSoftphone: false });
		}
	},
}));
