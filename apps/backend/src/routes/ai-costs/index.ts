import { createRouter } from "@/lib";
import { authMiddleware, requireRole } from "@/lib/auth";

import * as h from "./ai-costs.handlers";
import * as r from "./ai-costs.routes";

const router = createRouter();

router.use("/*", authMiddleware);
// What the business spends is finance, not operations: gated like Reports rather
// than like the AI assistant pages, which deliberately let a manager see their
// own sessions.
router.use("/*", requireRole("supervisor", "admin"));

router.openapi(r.summary, h.summaryHandler);
router.openapi(r.costCalls, h.callsHandler);
router.openapi(r.rates, h.ratesHandler);

export default router;
