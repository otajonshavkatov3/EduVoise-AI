import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./asterisk.handlers";
import * as r from "./asterisk.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.listExtensions, h.listExtensionsHandler);
router.openapi(r.syncExtensions, h.syncExtensionsHandler);
router.openapi(r.status, h.statusHandler);
router.openapi(r.originate, h.originateHandler);
router.openapi(r.transfer, h.transferHandler);
router.openapi(r.hangup, h.hangupHandler);

export default router;
