import type { ErrorCodeType, ErrorDetails } from "./error";

export interface SuccessResponse<T> {
	success: true;
	data: T;
}

export interface ErrorResponse {
	success: false;
	error: {
		code: ErrorCodeType;
		message: string;
		details?: ErrorDetails[];
	};
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

export interface PaginationMeta {
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

export interface PaginatedData<T> {
	items: T[];
	meta: PaginationMeta;
}

export interface PaginatedResponse<T> extends SuccessResponse<PaginatedData<T>> {}

export interface PaginationParams {
	page?: number;
	limit?: number;
}

export interface MessageData {
	message: string;
}

// Type guards
export function isSuccessResponse<T>(response: ApiResponse<T>): response is SuccessResponse<T> {
	return response.success === true;
}

export function isErrorResponse<T>(response: ApiResponse<T>): response is ErrorResponse {
	return response.success === false;
}
