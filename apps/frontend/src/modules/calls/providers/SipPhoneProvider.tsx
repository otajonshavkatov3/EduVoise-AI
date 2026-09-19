import { createContext, type ReactNode, useContext, useEffect } from "react";
import { shouldAutoConnect } from "../config/sip.config";
import { useSipPhone } from "../hooks/useSipPhone";
import { useSipStore } from "../store/sip.store";
import { requestNotificationPermission } from "../utils/notification";

type SipPhoneContextType = ReturnType<typeof useSipPhone>;

const SipPhoneContext = createContext<SipPhoneContextType | null>(null);

/**
 * SIP telefon provayeri.
 * MainLayout ichida o'rnatib, barcha child komponentlar SIP funksiyalaridan foydalanadi.
 */
export function SipPhoneProvider({ children }: { children: ReactNode }) {
	const sipPhone = useSipPhone();

	// Dastlabki ma'lumotlarni yuklash: operator holati + per-operator SIP hisob
	// ma'lumotlari. `fetchSipCredentials` konfiguratsiyani SHU operatorning o'z
	// extension/paroliga o'rnatadi — avval hamma bitta umumiy 201 bilan
	// ro'yxatdan o'tar, AI uzatgan qo'ng'iroq esa faqat bittasiga yetardi.
	useEffect(() => {
		sipPhone.fetchOperatorProfile();
		sipPhone.fetchSipCredentials();
	}, [sipPhone.fetchOperatorProfile, sipPhone.fetchSipCredentials]);

	// Brauzer bildirishnomalari uchun ruxsat.
	// `showCallNotification` ruxsat berilmagan bo'lsa hech narsa ko'rsatmaydi,
	// ruxsat esa hech qayerda so'ralmagan edi — ya'ni kiruvchi qo'ng'iroq
	// bildirishnomalari amalda hech qachon chiqmagan.
	useEffect(() => {
		requestNotificationPermission();
	}, []);

	// Sahifa yopilganda tozalash
	useEffect(() => {
		const handleBeforeUnload = () => {
			if (sipPhone.isRegistered) {
				sipPhone.disconnect();
			}
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
		};
	}, [sipPhone.isRegistered, sipPhone.disconnect]);

	// Online bo'lish NIYATIga qarab ulanish/uzilish (backend "operatorStatus"
	// emas — u registratsiyaga bog'langan, pastdagi effektga qarang).
	// Avtomatik ulanish faqat konfiguratsiya `autoConnect` bilan yoqilgan bo'lsa
	// amalga oshadi (sip.config.ts izohiga qarang): per-operator hisob olingach
	// `fetchSipCredentials` uni `true` qiladi, softfonsiz foydalanuvchilarda esa
	// faqat VITE_SIP_AUTO_CONNECT zaxira sifatida qoladi — sozlanmagan hostda
	// o'lik WebSocketga cheksiz qayta ulanish bo'lmasligi uchun.
	// Sozlamalar sahifasidagi "Saqlash va Ulanish" tugmasi bundan qat'i nazar
	// har doim ulaydi.
	useEffect(() => {
		if (sipPhone.desiredOnline) {
			// Kredensiallar hali yuklanmagan bo'lsa (`hasSoftphone === null`) kutamiz:
			// eskirgan localStorage konfiguratsiyasi (masalan umumiy 201) bilan
			// ulanib qolmaslik uchun. Yuklangach `config` per-operator hisobga
			// o'rnatilgan bo'ladi va shu effekt qayta ishga tushadi.
			if (sipPhone.hasSoftphone === null) {
				return;
			}
			if (sipPhone.connectionStatus === "disconnected" && shouldAutoConnect(sipPhone.config)) {
				sipPhone.connect();
			}
		} else if (sipPhone.connectionStatus !== "disconnected") {
			sipPhone.disconnect();
		}
	}, [
		sipPhone.desiredOnline,
		sipPhone.hasSoftphone,
		sipPhone.connectionStatus,
		sipPhone.config,
		sipPhone.connect,
		sipPhone.disconnect,
	]);

	// Presence registratsiyaga bog'langan. Backendga "online" deb FAQAT softfon
	// haqiqatan registratsiyadan o'tganda xabar beriladi; registratsiya
	// yo'qolsa darhol "offline" ga tushadi — aks holda AI uzatgan qo'ng'iroq
	// jiringlamaydigan telefonga yo'naltirilardi. Niyat (`desiredOnline`)
	// o'zgarmaydi, shuning uchun telefon qayta registratsiyadan o'tgach yana
	// "online" bo'ladi.
	useEffect(() => {
		if (sipPhone.desiredOnline && sipPhone.isRegistered && sipPhone.operatorStatus !== "online") {
			sipPhone.reportStatus("online");
		}
	}, [
		sipPhone.desiredOnline,
		sipPhone.isRegistered,
		sipPhone.operatorStatus,
		sipPhone.reportStatus,
	]);

	// Faqat profil yuklangandan keyin: undan oldin `operatorStatus` store'ning
	// boshlang'ich "online" qiymati, va SIP ma'lumotlari profildan tezroq kelsa,
	// har bir sahifa yuklanishi operatorni serverda "offline" qilib qo'yardi —
	// boshqa tabda haqiqatan online bo'lsa ham.
	const hasOperatorProfile = useSipStore((state) => state.hasOperatorProfile);

	useEffect(() => {
		if (
			hasOperatorProfile === true &&
			sipPhone.hasSoftphone === true &&
			sipPhone.operatorStatus === "online" &&
			!sipPhone.isRegistered
		) {
			sipPhone.reportStatus("offline");
		}
	}, [
		hasOperatorProfile,
		sipPhone.hasSoftphone,
		sipPhone.operatorStatus,
		sipPhone.isRegistered,
		sipPhone.reportStatus,
	]);

	return (
		<SipPhoneContext.Provider value={sipPhone}>
			{children}
			{/* Uzoq tomon ovozi uchun sink'lar. Aynan provayder ichida va shartsiz
			    turadi: React ref'ni birinchi render'da bog'laydi (sessiya o'rnatilishidan
			    ancha oldin), "Muloqot paneli" esa yopilishi yoki kichraytirilishi
			    mumkin — qo'ng'iroq davom etaveradi. Shartli render qilinsa element
			    qo'ng'iroq o'rtasida qayta yaratilib, srcObject yo'qoladi. */}
			<audio ref={sipPhone.remoteAudioRef} autoPlay playsInline>
				<track kind="captions" label="Subtitrlar yo'q" />
			</audio>
			<audio ref={sipPhone.consultationAudioRef} autoPlay playsInline>
				<track kind="captions" label="Subtitrlar yo'q" />
			</audio>
		</SipPhoneContext.Provider>
	);
}

/**
 * SIP telefon hook - istalgan komponentda SIP funksiyalarini olish uchun.
 * Faqat SipPhoneProvider ichida ishlaydi.
 */
export function useSipPhoneContext(): SipPhoneContextType {
	const context = useContext(SipPhoneContext);
	if (!context) {
		throw new Error("useSipPhoneContext faqat SipPhoneProvider ichida ishlatilishi kerak");
	}
	return context;
}
