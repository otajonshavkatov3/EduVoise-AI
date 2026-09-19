import { z } from "zod/v4";

// ===========================================
// Backend Environment Schema
// ===========================================
const serverEnvSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	PORT: z
		.string()
		.default("4000")
		.transform(Number)
		.pipe(z.number().min(1).max(65535)),
	HOST: z.string().default("0.0.0.0"),

	// Database
	DATABASE_URL: z.url(),

	// Redis
	REDIS_URL: z.url(),

	// JWT
	JWT_SECRET: z.string().min(32),
	JWT_EXPIRES_IN: z.string().default("15m"),
	JWT_REFRESH_SECRET: z.string().min(32),
	REFRESH_TOKEN_EXPIRES_IN: z.string().default("7d"),

	// ===========================================
	// AI voice layer (Asterisk + OpenAI Realtime)
	//
	// Every field below is optional or defaulted on purpose: the backend must
	// still boot for the pre-existing CRM routes even if the telephony stack
	// is not configured on a given host. A missing Asterisk password disables
	// the voice layer, it does not crash the API.
	// ===========================================

	// Asterisk ARI - call control
	ASTERISK_ARI_URL: z.string().default("http://localhost:8088/ari"),
	ASTERISK_ARI_WS_URL: z.string().default("ws://localhost:8088/ari/events"),
	ASTERISK_ARI_APP: z.string().default("callcenter-ai"),
	ASTERISK_ARI_USERNAME: z.string().default(""),
	ASTERISK_ARI_PASSWORD: z.string().default(""),

	// Asterisk AMI - endpoint / registration state
	ASTERISK_AMI_HOST: z.string().default("localhost"),
	ASTERISK_AMI_PORT: z
		.string()
		.default("5038")
		.transform(Number)
		.pipe(z.number().min(1).max(65535)),
	ASTERISK_AMI_USERNAME: z.string().default(""),
	ASTERISK_AMI_PASSWORD: z.string().default(""),

	// SIP / RTP. SIP is 5070 here because MicroSIP owns 5060 on the dev host.
	ASTERISK_SIP_PORT: z
		.string()
		.default("5070")
		.transform(Number)
		.pipe(z.number().min(1).max(65535)),
	ASTERISK_RTP_START: z.string().default("12000").transform(Number).pipe(z.number()),
	ASTERISK_RTP_END: z.string().default("12049").transform(Number).pipe(z.number()),

	// AudioSocket: Asterisk dials IN to this listener over TCP.
	AUDIOSOCKET_HOST: z.string().default("0.0.0.0"),
	AUDIOSOCKET_PORT: z
		.string()
		.default("9092")
		.transform(Number)
		.pipe(z.number().min(1).max(65535)),
	// What the dialplan is told to connect back to. Inside Docker the backend
	// lives on the host, hence host.docker.internal rather than localhost.
	AUDIOSOCKET_ADVERTISE_HOST: z.string().default("host.docker.internal:9092"),

	// OpenAI. The key is optional so the platform runs without it.
	OPENAI_API_KEY: z.string().optional(),
	OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime"),
	OPENAI_REALTIME_VOICE: z.string().default("alloy"),
	OPENAI_TRANSCRIBE_MODEL: z.string().default("whisper-1"),
	// gpt-4o-mini and not gpt-4.1-mini: this project's key returns 403
	// model_not_found for the latter.
	OPENAI_ANALYSIS_MODEL: z.string().default("gpt-4o-mini"),

	// AI agent behaviour
	AI_AGENT_ENABLED: z
		.string()
		.default("true")
		.transform((v) => v === "true" || v === "1"),
	AI_AGENT_EXTENSION: z.string().default("900"),
	AI_AGENT_LANGUAGE: z.string().default("uz"),
	AI_AGENT_MAX_CALL_SECONDS: z.string().default("900").transform(Number).pipe(z.number().min(30)),
	AI_AGENT_SILENCE_HANGUP_MS: z
		.string()
		.default("20000")
		.transform(Number)
		.pipe(z.number().min(1000)),
	AI_TRANSFER_EXTENSIONS: z.string().default("101,102,103,104"),

	// Recordings. The first is the path inside the Asterisk container, the
	// second is where the backend reads the same bind-mounted files from. Both
	// gain a per-tenant subdirectory: <dir>/<tenant slug>/<calls.id>.wav.
	ASTERISK_RECORDINGS_DIR: z.string().default("/var/spool/asterisk/recordings"),
	RECORDINGS_DIR: z.string().default("./apps/backend/uploads/call-recordings"),

	// Multi-tenant Asterisk. The customer this deployment ran as before tenancy:
	// the container bootstraps their endpoints from .env, the pre-tenancy dialplan
	// contexts forward to them, and they keep the bare-digit alias endpoints so a
	// softphone provisioned before tenancy still registers. See
	// lib/asterisk/tenant-config.ts.
	ASTERISK_LEGACY_TENANT_SLUG: z.string().default("avilab"),
	// Key for deriving a generated endpoint's SIP password. Empty = use the ARI
	// password, so a host with telephony configured needs no new secret.
	SIP_ENDPOINT_SECRET: z.string().default(""),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedServerEnv: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
	if (cachedServerEnv) {
		return cachedServerEnv;
	}

	const result = serverEnvSchema.safeParse(process.env);

	if (!result.success) {
		const formatted = z.prettifyError(result.error);
		throw new Error(`Invalid server environment variables:\n${formatted}`);
	}

	cachedServerEnv = result.data;
	return cachedServerEnv;
}

// ===========================================
// Frontend Environment Schema (Vite)
// ===========================================
const clientEnvSchema = z.object({
	VITE_API_URL: z.url(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

let cachedClientEnv: ClientEnv | null = null;

export function getClientEnv(): ClientEnv {
	if (cachedClientEnv) {
		return cachedClientEnv;
	}

	// Vite uses import.meta.env instead of process.env
	const envSource =
		typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : process.env;

	const result = clientEnvSchema.safeParse(envSource);

	if (!result.success) {
		const formatted = z.prettifyError(result.error);
		throw new Error(`Invalid client environment variables:\n${formatted}`);
	}

	cachedClientEnv = result.data;
	return cachedClientEnv;
}

export { serverEnvSchema, clientEnvSchema };
