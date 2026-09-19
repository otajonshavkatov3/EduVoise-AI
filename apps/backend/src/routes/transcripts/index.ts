import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./transcripts.handlers";
import * as r from "./transcripts.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.exportByCall, h.exportHandler);
router.openapi(r.listByCall, h.listHandler);
router.openapi(r.append, h.appendHandler);
router.openapi(r.update, h.updateHandler);

export default router;
