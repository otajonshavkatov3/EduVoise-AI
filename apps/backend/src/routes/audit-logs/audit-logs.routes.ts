import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { commonResponses } from "@/lib";

import { ListOutSchema, ListQuerySchema } from "./audit-logs.schemas";

export const list = createRoute({
	method: "get",
	path: "/",
	tags: ["Audit Logs"],
	summary: "List audit logs",
	description:
		"Supervisor/Admin: barcha audit loglar. Pagination va filter: userId, action, from, to.",
	request: {
		query: ListQuerySchema,
	},
	responses: {
		[HttpStatusCodes.OK]: {
			content: { "application/json": { schema: ListOutSchema } },
			description: "",
		},
		...commonResponses,
	},
	security: [{ bearerAuth: [] }],
});
