import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./ai-analyses.handlers";
import * as r from "./ai-analyses.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.list, h.listHandler);
router.openapi(r.retry, h.retryHandler);
router.openapi(r.get, h.getHandler);
router.openapi(r.update, h.updateHandler);

export default router;
