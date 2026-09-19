import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./tickets.handlers";
import * as r from "./tickets.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.list, h.listHandler);
router.openapi(r.get, h.getHandler);
router.openapi(r.create, h.createHandler);
router.openapi(r.update, h.updateHandler);
router.openapi(r.remove, h.removeHandler);

export default router;
