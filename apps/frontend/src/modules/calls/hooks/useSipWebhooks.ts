import { getClientEnv } from "@shared/env";
import axios from "axios";
import { useCallback } from "react";
import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import { normalizePhone } from "@/shared/utils/phoneFormat";
import { useCallPopStore } from "../store/callPop.store";

/**
 * PBX ichki raqami (mijoz raqami emas)mi?
 *
 * Ichki yo'nalishlar: 900 (AI agent), 600/601/602 (test), 700 (ovozli pochta),
 * 101-104 (stol telefonlari), 201-204 (brauzer telefoni) — bularning barchasi
 * 3-4 raqamli.
 *
 * NEGA KERAK: Asterisk dialplan'i operatorga qo'ng'iroq kelganda stol telefoni
 * bilan birga brauzer telefonini ham chaqiradi. Har bir shunday ichki "leg"
 * uchun webhook yuborilsa:
 *   1. `calls` jadvalida ikkinchi, keraksiz qator paydo bo'ladi — asosiy qatorni
 *      allaqachon call-orchestrator yozgan (AI sessiyasi, transkript, yozuv bilan);
 *   2. normalizePhone("101") → "998101" bo'lib, ichki raqam mijoz telefon
 *      raqamiga aylanib qoladi va soxta kontakt yaratilishi mumkin;
 *   3. transfer bekor qilinsa call-end kelmaydi va qator "ringing" holatida
 *      abadiy qotib qoladi, natijada dashboard statistikasi buziladi.
 *
 * Shu sababli ichki raqamlar uchun webhook yuborilmaydi. Tashqi mijoz
 * qo'ng'iroqlari (9 yoki 12 raqamli) avvalgidek to'liq yoziladi.
 */
function isInternalNumber(raw: string): boolean {
	const digits = raw.replace(/\D/g, "");
	return digits.length > 0 && digits.length <= 4;
}

/**
 * Backend webhook qo'ng'iroqlari uchun hook.
 * Call-start va call-end webhooklarini yuboradi.
 */
export function useSipWebhooks() {
	const env = getClientEnv();

	/**
	 * Yozuvni serverga yuklaydi.
	 *
	 * Webhook'lardan farqli o'laroq bu `apiClient` orqali ketadi: yuklash
	 * endpointi endi token talab qiladi (avval istalgan kishi serverga fayl
	 * yozib ketishi mumkin edi), `apiClient` esa Authorization sarlavhasini
	 * o'zi qo'shadi.
	 */
	const uploadRecording = useCallback(async (blob: Blob): Promise<string | null> => {
		try {
			const formData = new FormData();
			formData.append("file", blob, "call-recording.webm");
			const res = await apiClient.post<{
				success: boolean;
				data?: { path: string };
			}>(API_ENDPOINTS.UPLOADS.RECORDING, formData, {
				headers: { "Content-Type": "multipart/form-data" },
			});
			if (res.data?.success && res.data.data?.path) {
				return res.data.data.path;
			}
		} catch {
			// ignore upload errors on frontend
		}
		return null;
	}, []);

	const sendCallStartWebhook = useCallback(
		async (
			direction: "inbound" | "outbound",
			callerNumber: string,
			calleeExtension?: string
		): Promise<string | null> => {
			// Ichki raqamli leg — yuqoridagi izohga qarang.
			if (isInternalNumber(callerNumber)) {
				return null;
			}
			try {
				const res = await axios.post<{ id: string; success: boolean }>(
					`${env.VITE_API_URL}/api/webhooks/freepbx/call-start`,
					{
						direction,
						callerNumber: normalizePhone(callerNumber),
						calleeExtension: calleeExtension ? normalizePhone(calleeExtension) : undefined,
					}
				);
				if (res.data?.success && res.data.id) {
					useCallPopStore.getState().updateCall({ id: res.data.id });
					return res.data.id;
				}
			} catch {
				// ignore webhook errors on frontend
			}
			return null;
		},
		[env.VITE_API_URL]
	);

	const sendCallEndWebhook = useCallback(
		async (callId: string | null, durationSeconds: number, recordingPath?: string) => {
			if (!callId) {
				return;
			}
			try {
				await axios.post(`${env.VITE_API_URL}/api/webhooks/freepbx/call-end`, {
					callId,
					duration: durationSeconds,
					recordingPath: recordingPath ?? null,
					status: "completed",
				});
			} catch {
				// ignore webhook errors on frontend
			}
		},
		[env.VITE_API_URL]
	);

	// `sendMissedCallReport` olib tashlandi: u POST /api/calls/missed ga
	// murojaat qilardi, bunday route esa hech qachon mavjud bo'lmagan (backendda
	// faqat GET /calls/missed bor), so'rov tokensiz ketardi va xato bo'sh
	// `catch` ichida yutilardi — ya'ni funksiya hech qachon ishlamagan. Uni
	// hech bir komponent chaqirmasdi ham. Javobsiz kiruvchi qo'ng'iroqlar
	// baribir orchestrator va FreePBX call-start webhook'i orqali yoziladi.

	return {
		uploadRecording,
		sendCallStartWebhook,
		sendCallEndWebhook,
	};
}
