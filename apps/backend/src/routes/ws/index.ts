import { upgradeWebSocket } from "hono/bun";

import { createRouter } from "@/lib";
import { createWsEvents } from "@/lib/ws/ws-handler";

const router = createRouter();

router.get("/", upgradeWebSocket(createWsEvents));

export default router;
