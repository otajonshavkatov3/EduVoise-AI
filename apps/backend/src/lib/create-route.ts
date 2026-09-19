import { createRoute, type z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";

import { ErrorResponseSchema } from "./schemas";

type JsonContent<T extends z.ZodType> = ReturnType<typeof jsonContent<T>>;

export function successResponse<T extends z.ZodType>(
	schema: T,
	description: string
): JsonContent<T> {
	return jsonContent(schema, description);
}

export function errorResponse(description: string) {
	return jsonContent(ErrorResponseSchema, description);
}

export function jsonBody<T extends z.ZodType>(schema: T, description: string) {
	return jsonContentRequired(schema, description);
}

export const commonResponses = {
	[HttpStatusCodes.BAD_REQUEST]: {
		content: {
			"application/json": {
				schema: ErrorResponseSchema,
			},
		},
		description: "Bad request - validation error",
	},
	[HttpStatusCodes.UNAUTHORIZED]: {
		content: {
			"application/json": {
				schema: ErrorResponseSchema,
			},
		},
		description: "Unauthorized - authentication required",
	},
	[HttpStatusCodes.FORBIDDEN]: {
		content: {
			"application/json": {
				schema: ErrorResponseSchema,
			},
		},
		description: "Forbidden - insufficient permissions",
	},
	[HttpStatusCodes.NOT_FOUND]: {
		content: {
			"application/json": {
				schema: ErrorResponseSchema,
			},
		},
		description: "Resource not found",
	},
	[HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
		content: {
			"application/json": {
				schema: ErrorResponseSchema,
			},
		},
		description: "Internal server error",
	},
} as const;

export { createRoute };
export * as HttpStatusCodes from "stoker/http-status-codes";
export { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
