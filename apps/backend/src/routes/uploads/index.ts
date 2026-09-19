import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";
import {
	getCallRecordingHandler,
	getTenantCallRecordingHandler,
	uploadRecordingHandler,
} from "./uploads.handlers";
import { getCallRecording, getTenantCallRecording, uploadRecording } from "./uploads.routes";

const router = createRouter();

/**
 * Yozish yo'li token talab qiladi; o'qish yo'li yo'q.
 *
 * POST autentifikatsiyasiz turgani sof xavfsizlik teshigi edi: istalgan kishi
 * `uploads/call-recordings` ichiga fayl yozib ketishi mumkin edi. Frontend endi
 * bu so'rovni `apiClient` orqali yuboradi, ya'ni token o'zi qo'shiladi.
 *
 * GET esa ataylab ochiq qoldirilgan: yozuvlar `<audio src>` va `<a download>`
 * orqali o'ynatiladi/yuklanadi, bu elementlar esa Authorization sarlavhasini
 * yubora olmaydi. Uni yopish audio pleyerni blob yuklashga o'tkazishni talab
 * qiladi — bu ishlayotgan funksiyani qayta yozish bo'lgani uchun alohida
 * qarorga qoldirildi. Fayl nomi `basename()` bilan tozalanadi, ya'ni katalogdan
 * tashqariga chiqib bo'lmaydi.
 */
router.use("/recording", authMiddleware);

router.openapi(uploadRecording, uploadRecordingHandler);
router.openapi(getCallRecording, getCallRecordingHandler);
// Yozuvlar endi har bir mijozning O'Z katalogida saqlanadi
// (`/uploads/call-recordings/<slug>/<fayl>`), shu sababli ikkinchi yo'l. Eski
// bir bo'lakli yo'l ham qoladi: tenancy'dan oldingi 130+ yozuv shu shaklda.
router.openapi(getTenantCallRecording, getTenantCallRecordingHandler);

export default router;
