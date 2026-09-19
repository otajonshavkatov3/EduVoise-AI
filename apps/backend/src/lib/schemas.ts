import { z } from "@hono/zod-openapi";
import { ErrorCode } from "./errors";

export const IdParamSchema = z.object({
	id: z
		.string()
		.uuid()
		.openapi({
			param: { name: "id", in: "path", required: true },
			example: "123e4567-e89b-12d3-a456-426614174000",
		}),
});

export const SlugParamSchema = z.object({
	slug: z
		.string()
		.min(1)
		.openapi({
			param: { name: "slug", in: "path" },
			example: "my-resource-slug",
		}),
});

export const PaginationQuerySchema = z.object({
	page: z
		.string()
		.optional()
		.default("1")
		.transform(Number)
		.pipe(z.number().int().min(1))
		.openapi({
			param: { name: "page", in: "query" },
			example: "1",
		}),
	limit: z
		.string()
		.optional()
		.default("20")
		.transform(Number)
		.pipe(z.number().int().min(1).max(100))
		.openapi({
			param: { name: "limit", in: "query" },
			example: "20",
		}),
});

const ErrorCodeEnum = z.enum([
	ErrorCode.VALIDATION_ERROR,
	ErrorCode.INVALID_INPUT,
	ErrorCode.MISSING_FIELD,
	ErrorCode.INVALID_FORMAT,
	ErrorCode.UNAUTHORIZED,
	ErrorCode.INVALID_TOKEN,
	ErrorCode.TOKEN_EXPIRED,
	ErrorCode.INVALID_CREDENTIALS,
	ErrorCode.FORBIDDEN,
	ErrorCode.INSUFFICIENT_PERMISSIONS,
	ErrorCode.ACCESS_DENIED,
	ErrorCode.NOT_FOUND,
	ErrorCode.RESOURCE_NOT_FOUND,
	ErrorCode.USER_NOT_FOUND,
	ErrorCode.SCHOOL_NOT_FOUND,
	ErrorCode.CONFLICT,
	ErrorCode.ALREADY_EXISTS,
	ErrorCode.DUPLICATE_ENTRY,
	ErrorCode.UNPROCESSABLE_ENTITY,
	ErrorCode.BUSINESS_RULE_VIOLATION,
	ErrorCode.INVALID_OPERATION,
	ErrorCode.INVALID_STATE,
	ErrorCode.RATE_LIMIT_EXCEEDED,
	ErrorCode.INTERNAL_ERROR,
	ErrorCode.DATABASE_ERROR,
	ErrorCode.EXTERNAL_SERVICE_ERROR,
]);

export const ErrorDetailSchema = z
	.object({
		field: z.string().optional(),
		reason: z.string().optional(),
	})
	.loose()
	.openapi("ErrorDetail");

export const ErrorResponseSchema = z
	.object({
		success: z.literal(false),
		error: z.object({
			code: ErrorCodeEnum,
			message: z.string(),
			details: z.array(ErrorDetailSchema).optional(),
		}),
	})
	.openapi("ErrorResponse");

export function createSuccessSchema<T extends z.ZodType>(dataSchema: T, name: string) {
	return z
		.object({
			success: z.literal(true),
			data: dataSchema,
		})
		.openapi(`${name}Response`);
}

export function createListSchema<T extends z.ZodType>(itemSchema: T, name: string) {
	return z
		.object({
			success: z.literal(true),
			data: z.array(itemSchema),
		})
		.openapi(`${name}ListResponse`);
}

export const PaginationMetaSchema = z
	.object({
		total: z.number().int(),
		page: z.number().int(),
		limit: z.number().int(),
		totalPages: z.number().int(),
	})
	.openapi("PaginationMeta");

export function createPaginatedSchema<T extends z.ZodType>(itemSchema: T, name: string) {
	return z
		.object({
			success: z.literal(true),
			data: z.object({
				items: z.array(itemSchema),
				meta: PaginationMetaSchema,
			}),
		})
		.openapi(`Paginated${name}Response`);
}

export const emailSchema = z.string().email().openapi({ example: "user@example.com" });

export const phoneSchema = z
	.string()
	.regex(/^\+?[1-9]\d{1,14}$/)
	.openapi({ example: "+998901234567" });

export const passwordSchema = z.string().min(4).max(100).openapi({ example: "securePassword123" });

export const uuidSchema = z.uuid().openapi({ example: "123e4567-e89b-12d3-a456-426614174000" });

export const dateSchema = z.iso.date().openapi({ example: "2024-01-15" });

export const dateTimeSchema = z.iso.datetime().openapi({ example: "2024-01-15T10:30:00Z" });

export const timestampsSchema = z.object({
	createdAt: dateTimeSchema,
	updatedAt: dateTimeSchema,
});

export const MessageSchema = z
	.object({
		message: z.string(),
	})
	.openapi("Message");

export const SuccessMessageSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			message: z.string(),
		}),
	})
	.openapi("SuccessMessage");
