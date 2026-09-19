import { pinoLogger } from "hono-pino";
import pino from "pino";
import pretty from "pino-pretty";

export function createLogger() {
	const isDev = process.env.NODE_ENV !== "production";

	return pinoLogger({
		pino: pino(
			{
				level: isDev ? "debug" : "info",
			},
			isDev ? pretty({ colorize: true }) : undefined
		),
		http: {
			reqId: () => crypto.randomUUID(),
		},
	});
}
