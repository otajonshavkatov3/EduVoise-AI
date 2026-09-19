export type {
	ApiResponse,
	ErrorResponse,
	PaginatedData,
	PaginatedResponse,
	SuccessResponse,
} from "@shared/types";
export {
	configureOpenAPI,
	createRouter,
	default as createApp,
} from "./create-app";
export {
	commonResponses,
	createRoute,
	errorResponse,
	HttpStatusCodes,
	jsonBody,
	jsonContent,
	jsonContentRequired,
	successResponse,
} from "./create-route";
export type { ErrorCodeType, ErrorDetails } from "./errors";
export {
	AppError,
	alreadyExists,
	businessError,
	conflict,
	databaseError,
	ErrorCode,
	forbidden,
	insufficientPermissions,
	internalError,
	invalidCredentials,
	invalidInput,
	invalidOperation,
	invalidToken,
	notFound,
	rateLimitExceeded,
	tokenExpired,
	unauthorized,
	validationError,
} from "./errors";

export { created, error, noContent, paginated, success } from "./response";
export {
	createListSchema,
	createPaginatedSchema,
	createSuccessSchema,
	dateSchema,
	dateTimeSchema,
	ErrorDetailSchema,
	ErrorResponseSchema,
	emailSchema,
	IdParamSchema,
	MessageSchema,
	PaginationMetaSchema,
	PaginationQuerySchema,
	passwordSchema,
	phoneSchema,
	SlugParamSchema,
	SuccessMessageSchema,
	timestampsSchema,
	uuidSchema,
} from "./schemas";

export type { AppBindings, AppOpenAPI, AppRouteHandler } from "./types";
