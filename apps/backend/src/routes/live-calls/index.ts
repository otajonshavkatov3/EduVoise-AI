import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./live-calls.handlers";
import * as r from "./live-calls.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.list, h.listHandler);
router.openapi(r.get, h.getHandler);

export default router;
