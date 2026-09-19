import { ErrorCode, type ErrorCodeType, type ErrorDetails } from "@shared/types";
import * as HttpStatusCodes from "stoker/http-status-codes";

export { ErrorCode, type ErrorCodeType, type ErrorDetails };

export class AppError extends Error {
	public readonly statusCode: number;
	public readonly code: ErrorCodeType;
	public readonly details?: ErrorDetails[];
	public readonly isOperational: boolean;

	constructor(
		message: string,
		code: ErrorCodeType,
		statusCode: number = HttpStatusCodes.BAD_REQUEST,
		details?: ErrorDetails[]
	) {
		super(message);
		this.name = "AppError";
		this.code = code;
		this.statusCode = statusCode;
		this.details = details;
		this.isOperational = true;

		Error.captureStackTrace(this, this.constructor);
	}

	toJSON() {
		return {
			success: false as const,
			error: {
				code: this.code,
				message: this.message,
				details: this.details,
			},
		};
	}
}

export function validationError(message: string, details?: ErrorDetails[]) {
	return new AppError(message, ErrorCode.VALIDATION_ERROR, HttpStatusCodes.BAD_REQUEST, details);
}

/**
 * The reason is the message: `details[]` is not rendered by the frontend, so a
 * generic "noto'g'ri qiymat" headline would hide the only useful sentence.
 */
export function invalidInput(field: string, reason: string) {
	return new AppError(reason, ErrorCode.INVALID_INPUT, HttpStatusCodes.BAD_REQUEST, [
		{ field, reason },
	]);
}

export function unauthorized(message = "Tizimga kirish talab qilinadi") {
	return new AppError(message, ErrorCode.UNAUTHORIZED, HttpStatusCodes.UNAUTHORIZED);
}

export function invalidToken(message = "Token yaroqsiz") {
	return new AppError(message, ErrorCode.INVALID_TOKEN, HttpStatusCodes.UNAUTHORIZED);
}

export function tokenExpired(message = "Token muddati tugagan") {
	return new AppError(message, ErrorCode.TOKEN_EXPIRED, HttpStatusCodes.UNAUTHORIZED);
}

export function invalidCredentials(message = "Telefon raqami yoki parol noto'g'ri") {
	return new AppError(message, ErrorCode.INVALID_CREDENTIALS, HttpStatusCodes.UNAUTHORIZED);
}

export function forbidden(message = "Ruxsat yo'q") {
	return new AppError(message, ErrorCode.FORBIDDEN, HttpStatusCodes.FORBIDDEN);
}

export function insufficientPermissions(requiredRole?: string) {
	const message = requiredRole
		? `Ruxsat yetarli emas. Kerakli rol: ${requiredRole}`
		: "Ruxsat yetarli emas";
	return new AppError(message, ErrorCode.INSUFFICIENT_PERMISSIONS, HttpStatusCodes.FORBIDDEN);
}

export function notFound(resource = "Ma'lumot", id?: string) {
	const message = id ? `${resource} topilmadi (ID: ${id})` : `${resource} topilmadi`;
	return new AppError(message, ErrorCode.RESOURCE_NOT_FOUND, HttpStatusCodes.NOT_FOUND);
}

export function conflict(message: string, details?: ErrorDetails[]) {
	return new AppError(message, ErrorCode.CONFLICT, HttpStatusCodes.CONFLICT, details);
}

/** `field` is read by a person, so callers pass an Uzbek noun, not the column name. */
export function alreadyExists(resource: string, field?: string) {
	const message = field
		? `Bu ${field} bilan ${resource.toLowerCase()} allaqachon mavjud`
		: `${resource} allaqachon mavjud`;
	return new AppError(message, ErrorCode.ALREADY_EXISTS, HttpStatusCodes.CONFLICT);
}

export function businessError(message: string, details?: ErrorDetails[]) {
	return new AppError(
		message,
		ErrorCode.BUSINESS_RULE_VIOLATION,
		HttpStatusCodes.UNPROCESSABLE_ENTITY,
		details
	);
}

export function invalidOperation(message: string) {
	return new AppError(message, ErrorCode.INVALID_OPERATION, HttpStatusCodes.UNPROCESSABLE_ENTITY);
}

export function rateLimitExceeded(
	message = "So'rovlar juda ko'p. Birozdan so'ng qayta urinib ko'ring."
) {
	return new AppError(message, ErrorCode.RATE_LIMIT_EXCEEDED, HttpStatusCodes.TOO_MANY_REQUESTS);
}

export function internalError(message = "Kutilmagan xatolik yuz berdi") {
	return new AppError(message, ErrorCode.INTERNAL_ERROR, HttpStatusCodes.INTERNAL_SERVER_ERROR);
}

export function databaseError(message = "Ma'lumotlar bazasi amali bajarilmadi") {
	return new AppError(message, ErrorCode.DATABASE_ERROR, HttpStatusCodes.INTERNAL_SERVER_ERROR);
}
