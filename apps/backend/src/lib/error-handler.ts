import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { AppError, ErrorCode } from "./errors";
import type { ErrorResponse } from "./response";

export function errorHandler(err: Error, c: Context): Response {
	const logger = c.get("logger");

	if (err instanceof AppError) {
		if (err.statusCode >= 500) {
			logger?.error({ err, code: err.code }, err.message);
		} else {
			logger?.warn({ err, code: err.code }, err.message);
		}

		return c.json<ErrorResponse>(err.toJSON(), err.statusCode as ContentfulStatusCode);
	}

	if (err.name === "ZodError") {
		const zodError = err as {
			errors?: { path: (string | number)[]; message: string }[];
		};
		const details = zodError.errors?.map((e) => ({
			field: e.path.join("."),
			reason: e.message,
		}));

		logger?.warn({ err, details }, "Validation error");

		return c.json<ErrorResponse>(
			{
				success: false,
				error: {
					code: ErrorCode.VALIDATION_ERROR,
					message: "Ma'lumotlar tekshiruvdan o'tmadi",
					details,
				},
			},
			HttpStatusCodes.BAD_REQUEST as ContentfulStatusCode
		);
	}

	if (err.message?.includes("ECONNREFUSED") || err.message?.includes("connection")) {
		logger?.error({ err }, "Database connection error");

		return c.json<ErrorResponse>(
			{
				success: false,
				error: {
					code: ErrorCode.DATABASE_ERROR,
					message: "Xizmat vaqtincha ishlamayapti",
				},
			},
			HttpStatusCodes.SERVICE_UNAVAILABLE as ContentfulStatusCode
		);
	}

	logger?.error({ err, stack: err.stack }, "Unexpected error");

	return c.json<ErrorResponse>(
		{
			success: false,
			error: {
				code: ErrorCode.INTERNAL_ERROR,
				message:
					process.env.NODE_ENV === "development" ? err.message : "Kutilmagan xatolik yuz berdi",
			},
		},
		HttpStatusCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
	);
}

export function notFoundHandler(c: Context): Response {
	const logger = c.get("logger");
	logger?.warn({ path: c.req.path, method: c.req.method }, "Route not found");

	return c.json<ErrorResponse>(
		{
			success: false,
			error: {
				code: ErrorCode.NOT_FOUND,
				message: `So'ralgan manzil topilmadi: ${c.req.method} ${c.req.path}`,
			},
		},
		HttpStatusCodes.NOT_FOUND as ContentfulStatusCode
	);
}
