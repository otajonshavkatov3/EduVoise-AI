#!/usr/bin/env bun
/**
 * One command that answers "is the AI call centre actually up?".
 *
 *   bun --env-file=.env run tests/e2e/run-verification.ts
 *
 * It walks the whole stack in dependency order - Docker, Asterisk (SIP, ARI,
 * AMI, dialplan, modules), the backend's AudioSocket listener, Postgres, Redis,
 * the HTTP API including every new route group, and the OpenAI provider - and
 * prints one table. Exit code 0 means everything a caller needs is in place.
 *
 * Status meanings, because the difference matters when triaging:
 *
 *   PASS  verified, with evidence in the Detail column.
 *   WARN  working as currently configured, but degraded on purpose. The OpenAI
 *         account has no Realtime entitlement, so calls are served by the IVR
 *         fallback: that is a known, documented state and must not fail a run.
 *   SKIP  could not be checked because a prerequisite is absent (no Docker CLI).
 *         Never used to hide a failure of the thing being checked.
 *   FAIL  the stack is not ready. Exits non-zero.
 *
 * Nothing here mutates state: every check is a read, a TCP connect, or a
 * request that Asterisk answers without side effects. No call is placed, no
 * configuration is reconciled, no row is written.
 */
import { Buffer } from "node:buffer";
import dgram from "node:dgram";
import net from "node:net";

import { sql } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import { probeProviderHealth, selectedVoiceProviderName } from "../../apps/backend/src/lib/ai";
import { AmiClient } from "../../apps/backend/src/lib/asterisk";
import { redis } from "../../apps/backend/src/lib/redis";

// ===========================================
// Configuration
// ===========================================

const CONTAINER_NAME = "callcenter-asterisk";

const ARI_URL = (process.env.ASTERISK_ARI_URL ?? "http://localhost:8088/ari").replace(/\/+$/, "");
const ARI_USERNAME = process.env.ASTERISK_ARI_USERNAME ?? "";
const ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD ?? "";
const ARI_APP = process.env.ASTERISK_ARI_APP ?? "callcenter-ai";

const AMI_HOST = process.env.ASTERISK_AMI_HOST ?? "localhost";
const AMI_PORT = Number.parseInt(process.env.ASTERISK_AMI_PORT ?? "5038", 10);

const SIP_HOST = "127.0.0.1";
const SIP_PORT = Number.parseInt(process.env.ASTERISK_SIP_PORT ?? "5070", 10);

const AUDIOSOCKET_PORT = Number.parseInt(process.env.AUDIOSOCKET_PORT ?? "9092", 10);

const BACKEND_URL = (
	process.env.BACKEND_URL ?? `http://localhost:${process.env.PORT ?? "4000"}`
).replace(/\/+$/, "");

const SUPERVISOR = { phone: "+998900000000", password: "admin123" } as const;

const EXPECTED_ENDPOINTS = ["101", "102", "103", "104"];

const EXPECTED_CONTEXTS = [
	"from-internal",
	"from-external",
	"ai-bridge",
	"ai-transfer",
	"click-to-call",
];

const AUDIOSOCKET_MODULES = ["res_audiosocket.so", "app_audiosocket.so", "chan_audiosocket.so"];

/** Every table migrations 0000-0003 are expected to have created. */
const EXPECTED_TABLES = [
	"ai_analyses",
	"ai_sessions",
	"audit_logs",
	"bookings",
	"call_notes",
	"call_recordings",
	"call_transcripts",
	"call_transfers",
	"calls",
	"contacts",
	"follow_up_tasks",
	"operator_profiles",
	"operator_status_logs",
	"refresh_tokens",
	"sip_extensions",
	"tickets",
	"user_sessions",
	"users",
];

/** Read-only endpoints of the AI layer, with the status a healthy backend gives. */
const NEW_ENDPOINTS: Array<{ path: string; expect: number }> = [
	{ path: "/api/follow-ups", expect: 200 },
	{ path: "/api/bookings", expect: 200 },
	{ path: "/api/bookings/calendar", expect: 200 },
	{ path: "/api/live-calls", expect: 200 },
	{ path: "/api/asterisk/status", expect: 200 },
	{ path: "/api/asterisk/extensions", expect: 200 },
	{ path: "/api/ai-assistant/status", expect: 200 },
	{ path: "/api/ai-assistant/config", expect: 200 },
	{ path: "/api/ai-assistant/sessions", expect: 200 },
];

const TCP_TIMEOUT_MS = 3_000;
const UDP_TIMEOUT_MS = 3_000;
const HTTP_TIMEOUT_MS = 8_000;
/** GET /api/ai-assistant/status probes OpenAI, which is slow by nature. */
const SLOW_HTTP_TIMEOUT_MS = 40_000;
const AMI_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 10_000;
const DETAIL_COLUMN_WIDTH = 62;

// ===========================================
// Result collection
// ===========================================

type Status = "PASS" | "WARN" | "SKIP" | "FAIL";

interface CheckResult {
	group: string;
	name: string;
	status: Status;
	detail: string;
}

const results: CheckResult[] = [];

function record(group: string, name: string, status: Status, detail: string): CheckResult {
	const result = { group, name, status, detail };

	results.push(result);

	return result;
}

function describeError(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

// ===========================================
// Low-level probes
// ===========================================

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

async function runCommand(command: string[]): Promise<CommandResult> {
	try {
		const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (cause) {
		return { ok: false, stdout: "", stderr: describeError(cause) };
	}
}

function tcpProbe(host: string, port: number): Promise<{ ok: boolean; detail: string }> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		let settled = false;

		const settle = (ok: boolean, detail: string): void => {
			if (settled) {
				return;
			}

			settled = true;
			socket.destroy();
			resolve({ ok, detail });
		};

		socket.setTimeout(TCP_TIMEOUT_MS);
		socket.on("connect", () => settle(true, `TCP connect to ${host}:${port} succeeded`));
		socket.on("timeout", () => settle(false, `TCP connect to ${host}:${port} timed out`));
		socket.on("error", (error) => settle(false, `${host}:${port} - ${error.message}`));
	});
}

/**
 * Send a real SIP OPTIONS over UDP and wait for any SIP answer.
 *
 * A published UDP port is not proof of anything on its own; only a reply from
 * the SIP stack is. Asterisk answers "401 Unauthorized" to an unknown peer,
 * which counts: the transport is alive and processing SIP.
 */
function sipOptionsProbe(host: string, port: number): Promise<{ ok: boolean; detail: string }> {
	return new Promise((resolve) => {
		const socket = dgram.createSocket("udp4");
		const callId = `verification-${Date.now()}@${host}`;
		const request = [
			`OPTIONS sip:${host}:${port} SIP/2.0`,
			`Via: SIP/2.0/UDP ${host}:0;branch=z9hG4bK${Math.random().toString(36).slice(2, 12)};rport`,
			"Max-Forwards: 70",
			`From: <sip:verification@${host}>;tag=${Date.now()}`,
			`To: <sip:${host}:${port}>`,
			`Call-ID: ${callId}`,
			"CSeq: 1 OPTIONS",
			`Contact: <sip:verification@${host}:0>`,
			"Content-Length: 0",
			"",
			"",
		].join("\r\n");

		let settled = false;

		const settle = (ok: boolean, detail: string): void => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timer);

			try {
				socket.close();
			} catch {
				// Already closed by the error path.
			}

			resolve({ ok, detail });
		};

		const timer = setTimeout(
			() => settle(false, `no SIP answer from ${host}:${port}/udp within ${UDP_TIMEOUT_MS} ms`),
			UDP_TIMEOUT_MS
		);

		socket.on("message", (message) => {
			const statusLine = message.toString("utf8").split("\r\n")[0] ?? "";

			settle(statusLine.startsWith("SIP/2.0"), `answered "${statusLine}"`);
		});
		socket.on("error", (error) => settle(false, error.message));
		socket.send(Buffer.from(request, "utf8"), port, host);
	});
}

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function ariGet(path: string, password = ARI_PASSWORD): Promise<Response> {
	return fetch(`${ARI_URL}${path}`, {
		headers: { Authorization: basicAuth(ARI_USERNAME, password) },
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
	});
}

// ===========================================
// Docker
// ===========================================

/** Whether the container checks can run at all. */
let dockerAvailable = false;

async function checkDocker(): Promise<void> {
	const version = await runCommand(["docker", "info", "--format", "{{.ServerVersion}}"]);

	if (!version.ok) {
		record(
			"docker",
			"daemon",
			"SKIP",
			`docker is not usable here (${(version.stderr || "command failed").split("\n")[0]}). ` +
				"Asterisk is still checked directly over ARI/AMI."
		);
		return;
	}

	dockerAvailable = true;
	record("docker", "daemon", "PASS", `server version ${version.stdout}`);
}

async function checkContainer(): Promise<void> {
	if (!dockerAvailable) {
		record("docker", `container ${CONTAINER_NAME}`, "SKIP", "no docker CLI");
		return;
	}

	const inspected = await runCommand([
		"docker",
		"inspect",
		"-f",
		"{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
		CONTAINER_NAME,
	]);

	if (!inspected.ok) {
		record(
			"docker",
			`container ${CONTAINER_NAME}`,
			"FAIL",
			`not inspectable: ${(inspected.stderr || "unknown error").split("\n")[0]}`
		);
		return;
	}

	const [state = "", health = ""] = inspected.stdout.split("|");

	if (state !== "running") {
		record("docker", `container ${CONTAINER_NAME}`, "FAIL", `state is "${state}", expected running`);
		return;
	}

	if (health === "unhealthy") {
		record("docker", `container ${CONTAINER_NAME}`, "FAIL", "running but reported unhealthy");
		return;
	}

	record(
		"docker",
		`container ${CONTAINER_NAME}`,
		"PASS",
		`running, health=${health === "none" ? "no healthcheck" : health}`
	);
}

// ===========================================
// Asterisk
// ===========================================

async function checkSip(): Promise<void> {
	const tcp = await tcpProbe(SIP_HOST, SIP_PORT);

	record("asterisk", `SIP tcp/${SIP_PORT}`, tcp.ok ? "PASS" : "FAIL", tcp.detail);

	const udp = await sipOptionsProbe(SIP_HOST, SIP_PORT);

	record(
		"asterisk",
		`SIP udp/${SIP_PORT}`,
		udp.ok ? "PASS" : "FAIL",
		udp.ok ? `SIP OPTIONS ${udp.detail}` : udp.detail
	);
}

async function checkAri(): Promise<void> {
	if (ARI_USERNAME.length === 0 || ARI_PASSWORD.length === 0) {
		record(
			"asterisk",
			"ARI credentials",
			"FAIL",
			"ASTERISK_ARI_USERNAME / ASTERISK_ARI_PASSWORD are not set"
		);
		return;
	}

	try {
		const response = await ariGet("/asterisk/info");

		if (response.status !== 200) {
			record("asterisk", "ARI /asterisk/info", "FAIL", `HTTP ${response.status} from ${ARI_URL}`);
			return;
		}

		const info = (await response.json()) as {
			system?: { version?: string };
			status?: { startup_time?: string };
		};
		const version = info.system?.version ?? "unknown";
		const startedAt = info.status?.startup_time ?? "unknown";

		record(
			"asterisk",
			"ARI /asterisk/info",
			"PASS",
			`Asterisk ${version}, up since ${startedAt}, app=${ARI_APP}`
		);
	} catch (cause) {
		record("asterisk", "ARI /asterisk/info", "FAIL", `${ARI_URL} - ${describeError(cause)}`);
		return;
	}

	try {
		const rejected = await ariGet("/asterisk/info", `${ARI_PASSWORD}-wrong`);

		record(
			"asterisk",
			"ARI rejects bad credentials",
			rejected.status === 401 ? "PASS" : "FAIL",
			`a wrong password returned HTTP ${rejected.status} (expected 401)`
		);
	} catch (cause) {
		record("asterisk", "ARI rejects bad credentials", "FAIL", describeError(cause));
	}

	try {
		const response = await ariGet("/endpoints");
		const endpoints = (await response.json()) as Array<{ resource: string; technology: string }>;
		const present = new Set(
			endpoints.filter((item) => item.technology === "PJSIP").map((item) => item.resource)
		);
		const missing = EXPECTED_ENDPOINTS.filter((extension) => !present.has(extension));

		record(
			"asterisk",
			"PJSIP endpoints 101-104",
			missing.length === 0 ? "PASS" : "FAIL",
			missing.length === 0
				? `all four present (${EXPECTED_ENDPOINTS.join(", ")})`
				: `missing: ${missing.join(", ")}`
		);
	} catch (cause) {
		record("asterisk", "PJSIP endpoints 101-104", "FAIL", describeError(cause));
	}
}

const ami = new AmiClient({ receiveEvents: false, actionTimeoutMs: AMI_TIMEOUT_MS });
let amiReady = false;

async function checkAmi(): Promise<void> {
	try {
		await ami.login();
		amiReady = ami.isConnected;

		record(
			"asterisk",
			`AMI ${AMI_HOST}:${AMI_PORT}`,
			amiReady ? "PASS" : "FAIL",
			amiReady ? `authenticated, banner "${ami.serverBanner}"` : "login returned without a session"
		);
	} catch (cause) {
		record("asterisk", `AMI ${AMI_HOST}:${AMI_PORT}`, "FAIL", describeError(cause));
		return;
	}

	try {
		const packet = await ami.action("Ping");

		record(
			"asterisk",
			"AMI Ping",
			packet.Ping === "Pong" ? "PASS" : "FAIL",
			`Response=${packet.Response}, Ping=${packet.Ping ?? "(none)"}`
		);
	} catch (cause) {
		record("asterisk", "AMI Ping", "FAIL", describeError(cause));
	}
}

async function checkDialplan(): Promise<void> {
	if (!amiReady) {
		record("asterisk", "dialplan contexts", "FAIL", "AMI is unavailable, so nothing could be read");
		return;
	}

	const missing: string[] = [];
	const found: string[] = [];

	for (const context of EXPECTED_CONTEXTS) {
		try {
			const { events } = await ami.actionWithEvents("ShowDialPlan", { Context: context });
			const lines = events.filter(
				(event) => event.Event === "ListDialplan" && event.Context === context
			);

			if (lines.length === 0) {
				missing.push(context);
			} else {
				found.push(`${context}(${lines.length})`);
			}
		} catch (cause) {
			missing.push(`${context}: ${describeError(cause)}`);
		}
	}

	record(
		"asterisk",
		"dialplan contexts",
		missing.length === 0 ? "PASS" : "FAIL",
		missing.length === 0 ? found.join(", ") : `missing or unreadable: ${missing.join(", ")}`
	);

	try {
		const packet = await ami.action("Getvar", { Variable: "AI_STASIS_APP" });

		record(
			"asterisk",
			"AI_STASIS_APP matches ARI app",
			packet.Value === ARI_APP ? "PASS" : "FAIL",
			`dialplan global "${packet.Value}" vs ASTERISK_ARI_APP "${ARI_APP}"`
		);
	} catch (cause) {
		record("asterisk", "AI_STASIS_APP matches ARI app", "FAIL", describeError(cause));
	}
}

async function checkAudioSocketModules(): Promise<void> {
	if (!amiReady) {
		record("asterisk", "audiosocket modules", "FAIL", "AMI is unavailable");
		return;
	}

	const missing: string[] = [];

	for (const moduleName of AUDIOSOCKET_MODULES) {
		try {
			const packet = await ami.action("ModuleCheck", { Module: moduleName });

			if (packet.Response !== "Success") {
				missing.push(moduleName);
			}
		} catch {
			missing.push(moduleName);
		}
	}

	record(
		"asterisk",
		"audiosocket modules",
		missing.length === 0 ? "PASS" : "FAIL",
		missing.length === 0
			? `${AUDIOSOCKET_MODULES.join(", ")} loaded`
			: `not loaded: ${missing.join(", ")}`
	);
}

// ===========================================
// Backend infrastructure
// ===========================================

async function checkAudioSocketListener(): Promise<void> {
	const probe = await tcpProbe("127.0.0.1", AUDIOSOCKET_PORT);

	record(
		"backend",
		`AudioSocket listener :${AUDIOSOCKET_PORT}`,
		probe.ok ? "PASS" : "FAIL",
		probe.ok
			? `${probe.detail}; Asterisk is told to reach it at ${process.env.AUDIOSOCKET_ADVERTISE_HOST ?? "host.docker.internal:9092"}`
			: `${probe.detail}. The orchestrator binds this port in start(); nothing is listening, so an AI call would get silence.`
	);
}

async function checkPostgres(): Promise<void> {
	try {
		const result = await db.execute<{ table_name: string }>(
			sql`select table_name from information_schema.tables where table_schema = 'public'`
		);
		const rows = (result as unknown as { rows: Array<{ table_name: string }> }).rows;
		const present = new Set(rows.map((row) => row.table_name));
		const missing = EXPECTED_TABLES.filter((table) => !present.has(table));

		record(
			"database",
			"postgres connectivity",
			"PASS",
			`connected, ${present.size} tables in public schema`
		);
		record(
			"database",
			`${EXPECTED_TABLES.length} expected tables`,
			missing.length === 0 ? "PASS" : "FAIL",
			missing.length === 0
				? "all present (migrations 0000-0003 applied)"
				: `missing: ${missing.join(", ")} - run bun run db:migrate`
		);
	} catch (cause) {
		record("database", "postgres connectivity", "FAIL", describeError(cause));
		record("database", `${EXPECTED_TABLES.length} expected tables`, "FAIL", "no connection");
	}
}

async function checkRedis(): Promise<void> {
	try {
		const pong = await redis.send("PING", []);

		record(
			"database",
			"redis PING",
			String(pong).toUpperCase() === "PONG" ? "PASS" : "FAIL",
			`replied "${String(pong)}"`
		);
	} catch (cause) {
		record("database", "redis PING", "FAIL", describeError(cause));
	}
}

// ===========================================
// HTTP API
// ===========================================

let accessToken: string | null = null;

async function apiGet(path: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<Response> {
	return fetch(`${BACKEND_URL}${path}`, {
		headers: accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(timeoutMs),
	});
}

async function checkBackendHealth(): Promise<boolean> {
	try {
		const response = await apiGet("/api/health");

		if (response.status !== 200) {
			record("api", "GET /api/health", "FAIL", `HTTP ${response.status} from ${BACKEND_URL}`);
			return false;
		}

		const body = (await response.json()) as { status?: string; uptime?: number };

		record(
			"api",
			"GET /api/health",
			body.status === "ok" ? "PASS" : "FAIL",
			`status=${body.status}, uptime=${body.uptime}s at ${BACKEND_URL}`
		);

		return body.status === "ok";
	} catch (cause) {
		record(
			"api",
			"GET /api/health",
			"FAIL",
			`${BACKEND_URL} - ${describeError(cause)}. Start it with "bun run dev:backend".`
		);
		return false;
	}
}

async function checkLogin(): Promise<void> {
	try {
		const response = await fetch(`${BACKEND_URL}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(SUPERVISOR),
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		});

		if (response.status !== 200) {
			record(
				"api",
				"supervisor login",
				"FAIL",
				`HTTP ${response.status} for ${SUPERVISOR.phone} - has the database been seeded?`
			);
			return;
		}

		const body = (await response.json()) as {
			data?: { accessToken?: string; user?: { role?: string } };
		};

		accessToken = body.data?.accessToken ?? null;

		record(
			"api",
			"supervisor login",
			accessToken === null ? "FAIL" : "PASS",
			accessToken === null
				? "no accessToken in the response"
				: `authenticated as ${SUPERVISOR.phone} (${body.data?.user?.role})`
		);
	} catch (cause) {
		record("api", "supervisor login", "FAIL", describeError(cause));
	}
}

async function checkNewEndpoints(): Promise<void> {
	if (accessToken === null) {
		for (const { path } of NEW_ENDPOINTS) {
			record("api", `GET ${path}`, "FAIL", "no access token, so the endpoint was not called");
		}
		return;
	}

	for (const { path, expect } of NEW_ENDPOINTS) {
		try {
			const slow = path.startsWith("/api/ai-assistant/status");
			const response = await apiGet(path, slow ? SLOW_HTTP_TIMEOUT_MS : HTTP_TIMEOUT_MS);

			if (response.status === expect) {
				record("api", `GET ${path}`, "PASS", `HTTP ${response.status}`);
				continue;
			}

			record(
				"api",
				`GET ${path}`,
				"FAIL",
				response.status === 404
					? "HTTP 404 - the route group is not mounted in apps/backend/src/routes/index.ts"
					: `HTTP ${response.status}, expected ${expect}`
			);
		} catch (cause) {
			record("api", `GET ${path}`, "FAIL", describeError(cause));
		}
	}

	// Auth must be enforced on the new groups, not just present.
	const previous = accessToken;

	accessToken = null;

	try {
		const response = await apiGet("/api/live-calls");

		record(
			"api",
			"new groups require auth",
			response.status === 401 ? "PASS" : "FAIL",
			`GET /api/live-calls without a token returned HTTP ${response.status} (expected 401)`
		);
	} catch (cause) {
		record("api", "new groups require auth", "FAIL", describeError(cause));
	} finally {
		accessToken = previous;
	}
}

// ===========================================
// Voice provider
// ===========================================

/**
 * Checks the provider that will actually answer the next call.
 *
 * Deliberately not "is OpenAI healthy": AI_VOICE_PROVIDER decides which vendor
 * is on the phone, and this check used to hard-code openai-realtime as the only
 * acceptable answer - so a correctly configured Gemini deployment failed
 * verification while an unused OpenAI key passed it.
 */
async function checkVoiceProvider(): Promise<void> {
	const selected = selectedVoiceProviderName();

	if (selected === "fallback-ivr") {
		record(
			"ai",
			"voice provider",
			"WARN",
			"no speech provider is configured; calls use the IVR fallback"
		);
		return;
	}

	try {
		const health = await probeProviderHealth({ force: true, timeoutMs: PROBE_TIMEOUT_MS });

		if (health.available) {
			record(
				"ai",
				"voice provider",
				// The verdict has to describe the provider that was selected. Anything
				// else means the probe and the call path disagree.
				health.provider === selected ? "PASS" : "FAIL",
				`${health.provider}: ${health.detail}`
			);
			return;
		}

		if (health.provider !== "fallback-ivr") {
			// Incoherent: unavailable but still promising the AI.
			record(
				"ai",
				"voice provider",
				"FAIL",
				`reported available=false but provider="${health.provider}"`
			);
			return;
		}

		record("ai", "voice provider", "WARN", `degraded to ${health.provider}: ${health.detail}`);
	} catch (cause) {
		record("ai", "voice provider", "FAIL", describeError(cause));
	}
}

// ===========================================
// Reporting
// ===========================================

/** Built at runtime so no control character ends up in this source file. */
const ESC = String.fromCharCode(27);
const COLOURS: Record<Status, string> = {
	PASS: `${ESC}[32m`,
	WARN: `${ESC}[33m`,
	SKIP: `${ESC}[36m`,
	FAIL: `${ESC}[31m`,
};
const RESET = `${ESC}[0m`;

function paint(status: Status): string {
	return Bun.enableANSIColors ? `${COLOURS[status]}${status.padEnd(4)}${RESET}` : status.padEnd(4);
}

function truncate(value: string, width: number): string {
	const flat = value.replace(/\s+/g, " ").trim();

	return flat.length <= width ? flat : `${flat.slice(0, width - 3)}...`;
}

function printTable(): void {
	const indexWidth = String(results.length).length;
	const groupWidth = Math.max(5, ...results.map((result) => result.group.length));
	const nameWidth = Math.max(5, ...results.map((result) => result.name.length));
	const rule = `${"-".repeat(indexWidth + 2)}+${"-".repeat(groupWidth + 2)}+${"-".repeat(
		nameWidth + 2
	)}+${"-".repeat(6)}+${"-".repeat(DETAIL_COLUMN_WIDTH + 2)}`;

	const lines: string[] = [
		"",
		"AI CALL CENTRE - STACK VERIFICATION",
		`target: ${BACKEND_URL} | asterisk: ${ARI_URL} | ${new Date().toISOString()}`,
		"",
		`${"#".padEnd(indexWidth)}  | ${"GROUP".padEnd(groupWidth)} | ${"CHECK".padEnd(
			nameWidth
		)} | STAT | DETAIL`,
		rule,
	];

	results.forEach((result, index) => {
		lines.push(
			`${String(index + 1).padStart(indexWidth)}  | ${result.group.padEnd(
				groupWidth
			)} | ${result.name.padEnd(nameWidth)} | ${paint(result.status)} | ${truncate(
				result.detail,
				DETAIL_COLUMN_WIDTH
			)}`
		);
	});

	lines.push(rule);

	const counts: Record<Status, number> = { PASS: 0, WARN: 0, SKIP: 0, FAIL: 0 };

	for (const result of results) {
		counts[result.status] += 1;
	}

	lines.push(
		"",
		`${results.length} checks: ${counts.PASS} pass, ${counts.WARN} warn, ${counts.SKIP} skip, ${counts.FAIL} fail`
	);

	const notable = results.filter((result) => result.status !== "PASS");

	if (notable.length > 0) {
		lines.push("", "Anything that is not a plain PASS, in full:");

		for (const result of notable) {
			lines.push(`  [${result.status}] ${result.group} / ${result.name}`);
			lines.push(`         ${result.detail}`);
		}
	}

	lines.push(
		"",
		counts.FAIL === 0
			? "RESULT: the stack is ready. Dial 900 from a registered softphone to place a live AI call."
			: "RESULT: not ready - fix the FAIL rows above.",
		""
	);

	// biome-ignore lint/suspicious/noConsole: this script's entire output is the report.
	console.log(lines.join("\n"));
}

// ===========================================
// Main
// ===========================================

async function main(): Promise<number> {
	await checkDocker();
	await checkContainer();
	await checkSip();
	await checkAri();
	await checkAmi();
	await checkDialplan();
	await checkAudioSocketModules();
	await checkAudioSocketListener();
	await checkPostgres();
	await checkRedis();

	if (await checkBackendHealth()) {
		await checkLogin();
		await checkNewEndpoints();
	} else {
		record("api", "supervisor login", "FAIL", "the backend is not answering");
		for (const { path } of NEW_ENDPOINTS) {
			record("api", `GET ${path}`, "FAIL", "the backend is not answering");
		}
	}

	await checkVoiceProvider();

	printTable();

	return results.some((result) => result.status === "FAIL") ? 1 : 0;
}

const exitCode = await main();

ami.close();
redis.close();

try {
	const pool = db.$client as { end?: () => Promise<void> };

	await pool.end?.();
} catch {
	// The pool may already be closed; the report is what matters.
}

process.exit(exitCode);
