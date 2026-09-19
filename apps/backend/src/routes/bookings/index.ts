import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./bookings.handlers";
import * as r from "./bookings.routes";

const router = createRouter();
router.use("/*", authMiddleware);

// /calendar oldinda turishi kerak, aks holda /{id} uni ushlab qoladi.
router.openapi(r.calendar, h.calendarHandler);
router.openapi(r.list, h.listHandler);
router.openapi(r.create, h.createHandler);
router.openapi(r.get, h.getHandler);
router.openapi(r.update, h.updateHandler);
router.openapi(r.remove, h.removeHandler);

export default router;
