import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as full from "./calls.full.handlers";
import * as h from "./calls.handlers";
import * as r from "./calls.routes";

const router = createRouter();
router.use("/*", authMiddleware);

// More specific paths first so /missed and /export are not matched as :id
router.openapi(r.exportCalls, h.exportHandler);
router.openapi(r.missed, h.missedHandler);
router.openapi(r.getMeStats, h.getMeStatsHandler);
router.openapi(r.list, h.listHandler);
// Before /{id}: "/{id}/full" is a longer path, but registering it after leaves
// the outcome to router precedence rather than to this file.
router.openapi(r.getFull, full.getFullHandler);
router.openapi(r.get, h.getHandler);

export default router;
