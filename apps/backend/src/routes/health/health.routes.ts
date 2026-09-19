import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

const HealthResponseSchema = z
	.object({
		status: z.enum(["ok", "degraded", "down"]),
		timestamp: z.string().datetime(),
		uptime: z.number(),
	})
	.openapi("HealthResponse");

export const healthCheck = createRoute({
	method: "get",
	path: "/health",
	tags: ["Health"],
	summary: "Health check",
	description: "Returns the health status of the API",
	responses: {
		[HttpStatusCodes.OK]: {
			content: {
				"application/json": {
					schema: HealthResponseSchema,
				},
			},
			description: "Health status",
		},
	},
});
