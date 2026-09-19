import type { AppRouteHandler } from "../../lib";
import type { healthCheck } from "./health.routes";

const startTime = Date.now();

export const healthCheckHandler: AppRouteHandler<typeof healthCheck> = (c) => {
	const uptime = Math.floor((Date.now() - startTime) / 1000);

	return c.json(
		{
			status: "ok" as const,
			timestamp: new Date().toISOString(),
			uptime,
		},
		200
	);
};
