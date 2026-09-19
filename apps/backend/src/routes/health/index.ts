import { createRouter } from "@/lib";
import { healthCheckHandler } from "./health.handlers";
import { healthCheck } from "./health.routes";

const router = createRouter().openapi(healthCheck, healthCheckHandler);

export default router;
