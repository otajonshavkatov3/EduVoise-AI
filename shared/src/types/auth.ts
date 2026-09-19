import type { SuccessResponse } from "./response";
import type { User } from "./user";

export interface LoginRequest {
	phone: string;
	password: string;
}

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
}

export interface AuthData extends AuthTokens {
	user: User;
}

export interface RefreshTokenRequest {
	refreshToken: string;
}

export interface LogoutRequest {
	refreshToken: string;
}

// Auth API Response types
export type LoginResponse = SuccessResponse<AuthData>;
export type RefreshResponse = SuccessResponse<AuthTokens>;
export type MeResponse = SuccessResponse<User>;
export type LogoutResponse = SuccessResponse<{ message: string }>;
