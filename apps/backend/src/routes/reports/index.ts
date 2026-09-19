import { createRouter } from "@/lib";
import { authMiddleware, requireRole } from "@/lib/auth";

import * as h from "./reports.handlers";
import * as r from "./reports.routes";

const router = createRouter();

router.use("/*", authMiddleware);
// TZ 3.9: hisobotlarni eksport qilish — admin va supervisor huquqi. Manager
// hisobot ko'rmaydi, shuning uchun butun guruh middleware bilan yopiladi.
router.use("/*", requireRole("supervisor", "admin"));

router.openapi(r.callsExport, h.callsExportHandler);
router.openapi(r.callsReport, h.callsReportHandler);
router.openapi(r.ticketsExport, h.ticketsExportHandler);
router.openapi(r.ticketsReport, h.ticketsReportHandler);
router.openapi(r.operatorsExport, h.operatorsExportHandler);
router.openapi(r.operatorsReport, h.operatorsReportHandler);

export default router;
