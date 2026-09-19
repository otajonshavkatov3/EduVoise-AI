import type {
	ErrorCodeType,
	ErrorDetails,
	ErrorResponse,
	PaginatedResponse,
	SuccessResponse,
} from "@shared/types";

export type { ErrorResponse, PaginatedResponse, SuccessResponse } from "@shared/types";

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as HttpStatusCodes from "stoker/http-status-codes";

export function success<T>(
	c: Context,
	data: T,
	status: ContentfulStatusCode = HttpStatusCodes.OK as ContentfulStatusCode
) {
	return c.json<SuccessResponse<T>>(
		{
			success: true,
			data,
		},
		status
	);
}

export function created<T>(c: Context, data: T) {
	return success(c, data, HttpStatusCodes.CREATED as ContentfulStatusCode);
}

export function noContent(_c: Context) {
	return new Response(null, { status: HttpStatusCodes.NO_CONTENT });
}

export function paginated<T>(c: Context, items: T[], total: number, page: number, limit: number) {
	const totalPages = Math.ceil(total / limit);

	return c.json<PaginatedResponse<T>>(
		{
			success: true,
			data: {
				items,
				meta: {
					total,
					page,
					limit,
					totalPages,
				},
			},
		},
		HttpStatusCodes.OK as ContentfulStatusCode
	);
}

export function error(
	c: Context,
	code: ErrorCodeType,
	message: string,
	status: ContentfulStatusCode = HttpStatusCodes.BAD_REQUEST as ContentfulStatusCode,
	details?: ErrorDetails[]
) {
	return c.json<ErrorResponse>(
		{
			success: false,
			error: {
				code,
				message,
				details,
			},
		},
		status
	);
}
