/**
 * The HTTP surface the integration suites talk to.
 *
 * Every suite runs the *same* assertions against one of two transports:
 *
 *   live        fetch() against a backend that is already running (the default,
 *               and the only way to prove the deployed process behaves).
 *   in-process  app.request() against a Hono app the test file composes from
 *               the very same routers src/index.ts mounts. Used when no backend
 *               is listening, so the suite still verifies handlers, middleware
 *               and RBAC on a developer machine or in CI without a server.
 *
 * The transport is the only thing that changes - never the assertions. Which
 * one was used is printed once per suite so a green run is never ambiguous.
 */
import type { z } from "@hono/zod-openapi";

/** Created by `bun run db:seed`. The only account that exists on a fresh database. */
export const SEEDED_SUPERVISOR = {
	phone: "+998900000000",
	password: "admin123",
} as const;

const DEFAULT_PORT = "4000";
/** Long enough for GET /api/ai-assistant/status, which probes OpenAI (~13 s worst case). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_500;

export type ClientMode = "live" | "in-process";

export interface ApiResponse {
	status: number;
	headers: Headers;
	/** Raw body, kept so a failed assertion can show what actually came back. */
	text: string;
	/** Parsed JSON body, or null when the body was empty or not JSON. */
	body: unknown;
}

export interface RequestOptions {
	/** Bearer token. Omit to send the request unauthenticated. */
	token?: string;
	/** Serialised as JSON and sent with Content-Type: application/json. */
	json?: unknown;
	/** Sent verbatim - use for malformed-payload cases where `json` cannot help. */
	rawBody?: string;
	contentType?: string;
	headers?: Record<string, string>;
}

/**
 * Hono's `app.request()` may answer synchronously, so both shapes are accepted
 * and awaited.
 */
export type RequestFn = (path: string, init?: RequestInit) => Response | Promise<Response>;

export interface TestClient {
	readonly mode: ClientMode;
	/** Human-readable transport description, printed by the suites. */
	readonly label: string;
	send(method: string, path: string, options?: RequestOptions): Promise<ApiResponse>;
	get(path: string, options?: RequestOptions): Promise<ApiResponse>;
	post(path: string, options?: RequestOptions): Promise<ApiResponse>;
	patch(path: string, options?: RequestOptions): Promise<ApiResponse>;
	del(path: string, options?: RequestOptions): Promise<ApiResponse>;
}

export interface LoginResult {
	accessToken: string;
	refreshToken: string;
	user: {
		id: string;
		phone: string;
		role: "supervisor" | "admin" | "manager";
		isActive: boolean;
		createdAt: string;
	};
}

// ===========================================
// Transport
// ===========================================

function buildInit(method: string, options: RequestOptions): RequestInit {
	const headers: Record<string, string> = { ...options.headers };

	if (options.token !== undefined) {
		headers.Authorization = `Bearer ${options.token}`;
	}

	let body: string | undefined;

	if (options.rawBody !== undefined) {
		body = options.rawBody;
		headers["Content-Type"] = options.contentType ?? "application/json";
	} else if (options.json !== undefined) {
		body = JSON.stringify(options.json);
		headers["Content-Type"] = options.contentType ?? "application/json";
	}

	return { method, headers, body };
}

async function toApiResponse(response: Response): Promise<ApiResponse> {
	const text = await response.text();
	let body: unknown = null;

	if (text.length > 0) {
		try {
			body = JSON.parse(text);
		} catch {
			// Not JSON (CSV export, plain-text transcript) - `text` is the payload.
			body = null;
		}
	}

	return { status: response.status, headers: response.headers, text, body };
}

function fromRequestFn(mode: ClientMode, label: string, request: RequestFn): TestClient {
	const send = async (
		method: string,
		path: string,
		options: RequestOptions = {}
	): Promise<ApiResponse> => toApiResponse(await request(path, buildInit(method, options)));

	return {
		mode,
		label,
		send,
		get: (path, options) => send("GET", path, options),
		post: (path, options) => send("POST", path, options),
		patch: (path, options) => send("PATCH", path, options),
		del: (path, options) => send("DELETE", path, options),
	};
}

/** Talks to an already-running backend over the network. */
export function createLiveClient(
	baseUrl: string,
	timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): TestClient {
	const root = baseUrl.replace(/\/+$/, "");

	return fromRequestFn("live", root, (path, init) =>
		fetch(`${root}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
	);
}

/**
 * Talks to a Hono app inside this process. Pass a closure over `app.request`
 * rather than the app itself, so the helper stays independent of Hono's types.
 */
export function createInProcessClient(request: RequestFn): TestClient {
	return fromRequestFn("in-process", "in-process app (no server required)", request);
}

// ===========================================
// Discovery
// ===========================================

/** BACKEND_URL wins, then PORT from .env, then the project default. */
export function resolveBaseUrl(): string {
	const configured = process.env.BACKEND_URL?.trim();

	if (configured) {
		return configured.replace(/\/+$/, "");
	}

	return `http://localhost:${process.env.PORT ?? DEFAULT_PORT}`;
}

/** Status code of a GET, or null when the host could not be reached at all. */
export async function probeStatus(baseUrl: string, path: string): Promise<number | null> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});

		return response.status;
	} catch {
		return null;
	}
}

export async function isBackendReachable(baseUrl: string): Promise<boolean> {
	return (await probeStatus(baseUrl, "/api/health")) === 200;
}

// ===========================================
// Assertions and helpers
// ===========================================

/**
 * Assert the envelope every CRM endpoint uses (`{ success: true, data }`) and
 * return `data`. Throws with the real body, because "expected true to be false"
 * is useless when a handler answered 422.
 */
export function unwrap<T>(response: ApiResponse, what: string): T {
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`${what} answered HTTP ${response.status}: ${response.text.slice(0, 600)}`);
	}

	const body = response.body as { success?: unknown; data?: unknown } | null;

	if (body === null || body.success !== true || body.data === undefined) {
		throw new Error(`${what} did not return a { success: true, data } envelope: ${response.text}`);
	}

	return body.data as T;
}

/**
 * Validate a response against the zod schema the route itself declares in its
 * OpenAPI definition. This is the strongest available shape assertion: it fails
 * whenever a handler drifts from its published contract.
 */
export function parseWith<S extends z.ZodType>(
	schema: S,
	response: ApiResponse,
	what: string
): z.output<S> {
	const result = schema.safeParse(response.body);

	if (!result.success) {
		throw new Error(
			`${what} did not match its declared response schema (HTTP ${response.status}):\n${JSON.stringify(
				result.error.issues,
				null,
				2
			)}\nbody: ${response.text.slice(0, 800)}`
		);
	}

	return result.data;
}

export async function login(
	client: TestClient,
	phone: string,
	password: string
): Promise<LoginResult> {
	const response = await client.post("/api/auth/login", { json: { phone, password } });

	if (response.status !== 200) {
		throw new Error(
			`login as ${phone} failed with HTTP ${response.status}: ${response.text.slice(0, 400)}. ` +
				"Has the database been seeded (bun run db:seed)?"
		);
	}

	return unwrap<LoginResult>(response, "POST /api/auth/login");
}
