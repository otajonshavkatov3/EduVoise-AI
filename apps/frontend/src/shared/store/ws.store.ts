import { create } from "zustand";

/**
 * WebSocket ulanish holati — sarlavhadagi indikator uchun.
 *
 * Bu yerda `sendMessage` ham turardi: `useWebSocket` uni qaytarardi, MainLayout
 * store'ga yozardi va hech bir komponent uni o'qimasdi. Kanal amalda faqat bir
 * tomonlama (serverdan mijozga) — backend qabul qiladigan yagona xabar `ping`,
 * uning javobini esa hech kim tinglamaydi. Shuning uchun faqat haqiqatan
 * ishlatiladigan `status` qoldirildi.
 */
export type WsStatus = "connecting" | "connected" | "disconnected";

interface WsState {
	status: WsStatus;
}

interface WsActions {
	setStatus: (status: WsState["status"]) => void;
}

export const useWsStore = create<WsState & WsActions>((set) => ({
	status: "disconnected",
	setStatus: (status) => set({ status }),
}));
