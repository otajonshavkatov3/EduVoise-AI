import { createRouter } from "@/lib";

import { callEndHandler, callStartHandler } from "./freepbx.handlers";
import { callEnd, callStart } from "./freepbx.routes";

const router = createRouter();
router.openapi(callStart, callStartHandler);
router.openapi(callEnd, callEndHandler);
export default router;
