import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./campaigns.handlers";
import * as leads from "./campaigns.leads.handlers";
import * as r from "./campaigns.routes";

const router = createRouter();
router.use("/*", authMiddleware);

// Static paths before parameterised ones, exactly as calls/ and knowledge-base/ do:
// "/dnc" would otherwise be a candidate for "/{id}" and the uuid param schema would
// turn a valid request into a 400. Longer parameterised paths are also registered
// before their shorter prefixes rather than relying on router precedence.
router.openapi(r.list, h.listHandler);
router.openapi(r.create, h.createHandler);
router.openapi(r.listDnc, leads.listDncHandler);
router.openapi(r.createDnc, leads.createDncHandler);
router.openapi(r.removeDnc, leads.removeDncHandler);
router.openapi(r.importLeads, leads.importLeadsHandler);
router.openapi(r.getLead, h.getLeadHandler);
router.openapi(r.updateLead, h.updateLeadHandler);
router.openapi(r.listLeads, h.listLeadsHandler);
router.openapi(r.progress, h.progressHandler);
router.openapi(r.start, h.startHandler);
router.openapi(r.pause, h.pauseHandler);
router.openapi(r.cancel, h.cancelHandler);
router.openapi(r.get, h.getHandler);
router.openapi(r.update, h.updateHandler);
router.openapi(r.remove, h.removeHandler);

export default router;
