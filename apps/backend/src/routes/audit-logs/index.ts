import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./audit-logs.handlers";
import * as r from "./audit-logs.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.list, h.listHandler);

export default router;
