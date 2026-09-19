import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./ai-assistant.handlers";
import * as r from "./ai-assistant.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.status, h.statusHandler);
router.openapi(r.getConfig, h.getConfigHandler);
router.openapi(r.updateConfig, h.updateConfigHandler);
router.openapi(r.voicePreview, h.voicePreviewHandler);
router.openapi(r.listSessions, h.listSessionsHandler);
router.openapi(r.getSession, h.getSessionHandler);

export default router;
