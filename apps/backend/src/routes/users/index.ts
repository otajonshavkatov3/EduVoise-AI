import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./users.handlers";
import * as r from "./users.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.list, h.listHandler);
// `/me/profile` `/{id}` dan oldin ro'yxatga olinadi.
router.openapi(r.getMyProfile, h.getMyProfileHandler);
router.openapi(r.get, h.getHandler);
router.openapi(r.update, h.updateHandler);
router.openapi(r.remove, h.removeHandler);

export default router;
