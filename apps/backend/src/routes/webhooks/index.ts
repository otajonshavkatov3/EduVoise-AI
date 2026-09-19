import { createRouter } from "@/lib";

import freepbx from "./freepbx";

const router = createRouter();
router.route("/freepbx", freepbx);
export default router;
