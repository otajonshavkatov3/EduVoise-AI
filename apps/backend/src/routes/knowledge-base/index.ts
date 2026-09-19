import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./knowledge-base.handlers";
import * as r from "./knowledge-base.routes";

const router = createRouter();
router.use("/*", authMiddleware);

// Static paths first, exactly as calls/ does with "/missed" and "/export": "/stats"
// would otherwise be a candidate for "/{id}", and the uuid param schema would turn
// a valid request into a 400.
router.openapi(r.list, h.listHandler);
router.openapi(r.create, h.createHandler);
router.openapi(r.bulk, h.bulkHandler);
router.openapi(r.search, h.searchHandler);
router.openapi(r.stats, h.statsHandler);
router.openapi(r.get, h.getHandler);
router.openapi(r.update, h.updateHandler);
router.openapi(r.remove, h.removeHandler);

export default router;
