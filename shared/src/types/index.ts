// Error types
export { ErrorCode, type ErrorCodeType, type ErrorDetails } from "./error";

// Response types
export {
	type SuccessResponse,
	type ErrorResponse,
	type ApiResponse,
	type PaginationMeta,
	type PaginatedData,
	type PaginatedResponse,
	type PaginationParams,
	type MessageData,
	isSuccessResponse,
	isErrorResponse,
} from "./response";

// User types
export { UserRole, type UserRoleType, type User } from "./user";

// Tenant types - the branded id every tenant-owned row carries
export { asTenantId, isTenantId, type TenantId } from "./tenant";

// Auth types
export {
	type LoginRequest,
	type AuthTokens,
	type AuthData,
	type RefreshTokenRequest,
	type LogoutRequest,
	type LoginResponse,
	type RefreshResponse,
	type MeResponse,
	type LogoutResponse,
} from "./auth";
