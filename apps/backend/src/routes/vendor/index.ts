import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./vendor.handlers";
import * as r from "./vendor.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.listTenants, h.listTenantsHandler);
router.openapi(r.enterTenant, h.enterTenantHandler);

export default router;
