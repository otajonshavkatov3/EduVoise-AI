import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./operator-profiles.handlers";
import * as r from "./operator-profiles.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.list, h.listHandler);
router.openapi(r.getMe, h.getMeHandler);
router.openapi(r.getMeSip, h.getMeSipHandler);
router.openapi(r.get, h.getHandler);
router.openapi(r.create, h.createHandler);
router.openapi(r.updateMeStatus, h.updateMeStatusHandler);
router.openapi(r.update, h.updateHandler);
router.openapi(r.remove, h.removeHandler);

export default router;
