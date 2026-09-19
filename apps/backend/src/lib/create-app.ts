import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { serveEmojiFavicon } from "stoker/middlewares";
import { defaultHook } from "stoker/openapi";
import { errorHandler, notFoundHandler } from "./error-handler";
import { createLogger } from "./logger";
import type { AppBindings } from "./types";

export function createRouter() {
	return new OpenAPIHono<AppBindings>({
		strict: false,
		defaultHook,
	});
}

export default function createApp() {
	const app = createRouter();
	app.use(
		cors({
			origin: "*",
		})
	);
	app.use(serveEmojiFavicon("🚀"));
	app.use(createLogger());

	app.notFound(notFoundHandler);
	app.onError(errorHandler);

	return app;
}

export function configureOpenAPI(app: OpenAPIHono<AppBindings>) {
	app.doc("/doc", {
		openapi: "3.0.0",
		info: {
			title: "M Smart API",
			version: "1.0.0",
			description: "API documentation",
		},
		security: [{ bearerAuth: [] }],
	});

	app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
		type: "http",
		scheme: "bearer",
		bearerFormat: "JWT",
	});

	app.get(
		"/reference",
		Scalar({
			theme: "kepler",
			layout: "modern",
			persistAuth: true,
			defaultHttpClient: {
				targetKey: "js",
				clientKey: "fetch",
			},
			url: "/doc",
		})
	);
}
