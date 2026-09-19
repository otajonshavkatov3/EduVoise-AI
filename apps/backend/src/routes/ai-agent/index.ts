import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./ai-agent.handlers";
import * as r from "./ai-agent.routes";

const router = createRouter();
router.use("/*", authMiddleware);

// "/profile" and "/profiles" are distinct static segments, and
// "/profiles/{id}/activate" is longer than "/profiles/{id}", so no route here can
// swallow another. The static ones are still registered first, as the rest of the
// codebase does (see calls: "/missed", "/export" before "/{id}").
router.openapi(r.listProfiles, h.listProfilesHandler);
router.openapi(r.getActive, h.getActiveHandler);
router.openapi(r.createProfile, h.createProfileHandler);
router.openapi(r.activate, h.activateHandler);
router.openapi(r.updateProfile, h.updateProfileHandler);
router.openapi(r.removeProfile, h.removeProfileHandler);

export default router;
