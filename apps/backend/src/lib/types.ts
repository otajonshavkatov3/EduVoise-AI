import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { TenantId, UserRoleType } from "@shared/types";
import type { PinoLogger } from "hono-pino";

import type { TenantScope } from "./tenancy/scope";

export interface AuthUser {
	id: string;
	role: UserRoleType;
	/**
	 * The tenant this request acts inside. Duplicated from the tenant scope on
	 * purpose: `c.get("user")` is what 40-odd handlers already reach for, and a
	 * handler that has the user but not the tenant is a handler one line away from
	 * an unscoped query.
	 */
	tenantId: TenantId;
}

export interface AppBindings {
	// biome-ignore lint/style/useNamingConvention: Hono requires this exact property name
	Variables: {
		logger: PinoLogger;
		user: AuthUser;
		/**
		 * Set by authMiddleware. Everything a query needs to be scoped, plus who is
		 * really acting - see lib/tenancy/scope.ts.
		 */
		tenant: TenantScope;
	};
}

export type AppOpenAPI = OpenAPIHono<AppBindings>;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;
