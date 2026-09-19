import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import {
	callVolumeHandler,
	missedCallsHandler,
	overviewHandler,
	summaryHandler,
} from "./dashboard.handlers";
import { callVolume, missedCalls, overview, summary } from "./dashboard.routes";

const router = createRouter();

// GET /summary uzoq vaqt autentifikatsiyasiz ishlab keldi va biznes
// ko'rsatkichlarini (qo'ng'iroqlar soni, murojaatlar) istalgan kishiga ochib
// qo'yardi. Frontendda uni chaqiruvchi kod yo'q, shuning uchun token talabi
// hech qanday ishlayotgan ekranni buzmaydi — endpoint esa qolgan hammasi
// bilan bir xil himoya ostida.
router.use("/*", authMiddleware);

router.openapi(summary, summaryHandler);
router.openapi(overview, overviewHandler);
router.openapi(callVolume, callVolumeHandler);
router.openapi(missedCalls, missedCallsHandler);

export default router;
