import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./settings.handlers";
import * as r from "./settings.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.list, h.listHandler);
router.openapi(r.update, h.updateHandler);
router.openapi(r.testTelegram, h.testTelegramHandler);

export default router;
