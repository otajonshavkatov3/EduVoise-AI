/**
 * The live Asterisk container, checked through the same two interfaces the
 * backend uses: ARI over HTTP and AMI over TCP.
 *
 * This suite asserts infrastructure facts the AI voice layer silently depends
 * on. Every one of them has broken at least once during development, and every
 * one of them produces a confusing symptom rather than a clear error:
 *
 *   ARI credentials      wrong password -> "the socket closed", no more detail.
 *   the four endpoints   a missing PJSIP endpoint means a transfer just fails.
 *   dialplan contexts    a missing context makes continueInDialplan hang up.
 *   AI_STASIS_APP        the dialplan uses a global, so a mismatch with
 *                        ASTERISK_ARI_APP means Stasis() dials into nowhere.
 *   audiosocket modules  without them AudioSocket() is "no such application"
 *                        and the caller hears silence.
 *
 * Not testable here, and deliberately not faked: audio actually flowing over
 * AudioSocket needs a real channel, i.e. a softphone dialling 900. The closest
 * observable things - the modules being loaded, the dialplan calling
 * AudioSocket with AS_UUID/AS_HOST, and the backend's TCP listener - are
 * checked here and in tests/e2e/run-verification.ts.
 *
 * If the container is not running the whole suite is skipped with an explicit
 * message rather than failing: a developer without Docker should not see red.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import { AmiActionError, AmiClient } from "../../apps/backend/src/lib/asterisk";

// ===========================================
// Configuration
// ===========================================

const ARI_URL = (process.env.ASTERISK_ARI_URL ?? "http://localhost:8088/ari").replace(/\/+$/, "");
const ARI_USERNAME = process.env.ASTERISK_ARI_USERNAME ?? "";
const ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD ?? "";
const ARI_APP = process.env.ASTERISK_ARI_APP ?? "callcenter-ai";
const RECORDINGS_DIR = process.env.ASTERISK_RECORDINGS_DIR ?? "/var/spool/asterisk/recordings";

/**
 * The customer this deployment ran as before tenancy. Its extensions keep their
 * bare-digit ALIAS endpoints, which is why both names are expected below.
 */
const LEGACY_SLUG = process.env.ASTERISK_LEGACY_TENANT_SLUG ?? "avilab";

/** The softphone endpoints this deployment provisions. 900 is the AI agent. */
const EXPECTED_ENDPOINTS = ["101", "102", "103", "104"] as const;

/**
 * Every endpoint is ALSO provisioned under its tenant-qualified name, and that is
 * the one the dialplan dials: `avilab-101`. The bare-digit names are aliases kept
 * for phones provisioned before tenancy.
 */
const EXPECTED_TENANT_ENDPOINTS = EXPECTED_ENDPOINTS.map(
	(extension) => `${LEGACY_SLUG}-${extension}`
);

/**
 * The pre-tenancy context names. They still exist, and they now FORWARD to the
 * legacy tenant's own contexts - see the "forwards to" tests below.
 */
const LEGACY_CONTEXTS = [
	"from-internal",
	"from-external",
	"ai-bridge",
	"ai-transfer",
	"click-to-call",
] as const;

/**
 * Where the dialplan logic actually lives now: one set of contexts per customer,
 * generated from the tenants table and inheriting the `(!)` templates in
 * extensions.conf. A call executing in one of them can reach nothing else.
 */
const TENANT_CONTEXTS = {
	internal: `from-internal-${LEGACY_SLUG}`,
	external: `from-external-${LEGACY_SLUG}`,
	aiBridge: `ai-bridge-${LEGACY_SLUG}`,
	aiTransfer: `ai-transfer-${LEGACY_SLUG}`,
	clickToCall: `click-to-call-${LEGACY_SLUG}`,
} as const;

const EXPECTED_CONTEXTS = [...LEGACY_CONTEXTS, ...Object.values(TENANT_CONTEXTS)] as const;

const AUDIOSOCKET_MODULES = [
	"res_audiosocket.so",
	"app_audiosocket.so",
	"chan_audiosocket.so",
] as const;

/** AudioSocket needs Asterisk 18+; this deployment runs 20.x. */
const MIN_ASTERISK_MAJOR = 18;

const PROBE_TIMEOUT_MS = 4_000;
const AMI_ACTION_TIMEOUT_MS = 8_000;

interface AriInfo {
	build?: Record<string, unknown>;
	system?: { version?: string; entity_id?: string };
	status?: { startup_time?: string; last_reload_time?: string };
}

interface AriEndpoint {
	technology: string;
	resource: string;
	state: string;
	channel_ids: string[];
}

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function ariGet(
	path: string,
	credentials: { username: string; password: string } = {
		username: ARI_USERNAME,
		password: ARI_PASSWORD,
	}
): Promise<Response> {
	return fetch(`${ARI_URL}${path}`, {
		headers: { Authorization: basicAuth(credentials.username, credentials.password) },
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
}

/**
 * Is the container there at all? Any HTTP answer counts, including 401 - that
 * still proves Asterisk is listening, which is what decides skip vs fail.
 */
async function isAriListening(): Promise<boolean> {
	try {
		await ariGet("/asterisk/info");
		return true;
	} catch {
		return false;
	}
}

const ariListening = await isAriListening();

if (!ariListening) {
	// biome-ignore lint/suspicious/noConsole: the skip reason must be visible.
	console.warn(
		`[asterisk-ari] SKIPPED: nothing answered at ${ARI_URL}. Start the container ` +
			'("docker compose up -d asterisk") and re-run. Credentials come from ' +
			"ASTERISK_ARI_* / ASTERISK_AMI_* in .env."
	);
}

const describeLive = ariListening ? describe : describe.skip;

/** One shared authenticated AMI session, closed in afterAll. */
const ami = new AmiClient({ receiveEvents: false, actionTimeoutMs: AMI_ACTION_TIMEOUT_MS });

afterAll(() => {
	ami.close();
});

// ===========================================
// ARI
// ===========================================

describeLive("ARI REST", () => {
	test("credentials are configured at all", () => {
		// A blank username or password would make every assertion below fail with
		// a 401 that looks like an Asterisk problem, so say it plainly.
		expect(ARI_USERNAME.length).toBeGreaterThan(0);
		expect(ARI_PASSWORD.length).toBeGreaterThan(0);
	});

	test("GET /asterisk/info authenticates and identifies a supported Asterisk", async () => {
		const response = await ariGet("/asterisk/info");

		expect(response.status).toBe(200);

		const info = (await response.json()) as AriInfo;
		const version = info.system?.version ?? "";

		expect(version.length).toBeGreaterThan(0);

		const major = Number.parseInt(version.split(".")[0] ?? "0", 10);

		expect(major).toBeGreaterThanOrEqual(MIN_ASTERISK_MAJOR);
		expect(info.system?.entity_id).toBeTruthy();
		expect(Number.isNaN(Date.parse(info.status?.startup_time ?? ""))).toBe(false);
	});

	test("ARI is not open to the world - a wrong password is 401", async () => {
		const response = await ariGet("/asterisk/info", {
			username: ARI_USERNAME,
			password: `${ARI_PASSWORD}-wrong`,
		});

		expect(response.status).toBe(401);
	});

	test("the four operator endpoints exist as PJSIP endpoints", async () => {
		const response = await ariGet("/endpoints");

		expect(response.status).toBe(200);

		const endpoints = (await response.json()) as AriEndpoint[];
		const byResource = new Map(endpoints.map((endpoint) => [endpoint.resource, endpoint]));

		for (const extension of EXPECTED_ENDPOINTS) {
			const endpoint = byResource.get(extension);

			expect(endpoint).toBeDefined();
			expect(endpoint?.technology).toBe("PJSIP");
			// State is "online"/"offline" depending on whether a softphone is
			// registered right now, so it is deliberately not asserted.
			expect(typeof endpoint?.state).toBe("string");
		}
	});

	test("listing channels works, which is what /api/asterisk/status depends on", async () => {
		const response = await ariGet("/channels");

		expect(response.status).toBe(200);
		expect(Array.isArray(await response.json())).toBe(true);
	});
});

// ===========================================
// AMI
// ===========================================

describeLive("AMI", () => {
	test("logs in and reports the Asterisk Call Manager banner", async () => {
		await ami.login();

		expect(ami.isConnected).toBe(true);
		expect(ami.serverBanner ?? "").toContain("Asterisk Call Manager");
	});

	test("Ping answers Pong", async () => {
		const packet = await ami.action("Ping");

		expect(packet.Response).toBe("Success");
		expect(packet.Ping).toBe("Pong");
	});

	test("AMI is not open to the world - a wrong password is refused", async () => {
		const rogue = new AmiClient({
			username: process.env.ASTERISK_AMI_USERNAME ?? "",
			password: `${process.env.ASTERISK_AMI_PASSWORD ?? ""}-wrong`,
			receiveEvents: false,
			actionTimeoutMs: AMI_ACTION_TIMEOUT_MS,
		});

		try {
			await expect(rogue.login()).rejects.toThrow();
			expect(rogue.isConnected).toBe(false);
		} finally {
			rogue.close();
		}
	});

	test("PJSIP endpoints are visible over AMI, which /api/asterisk/extensions needs", async () => {
		const endpoints = await ami.pjsipShowEndpoints();
		const names = endpoints.map((endpoint) => endpoint.endpoint);

		for (const extension of EXPECTED_ENDPOINTS) {
			expect(names).toContain(extension);
		}

		for (const endpoint of endpoints) {
			expect(endpoint.state.length).toBeGreaterThan(0);
		}
	});
});

// ===========================================
// Dialplan
// ===========================================

interface DialplanLine {
	extension: string;
	priority: number;
	application: string;
	appData: string;
}

async function showDialplan(context: string): Promise<DialplanLine[]> {
	const { events } = await ami.actionWithEvents("ShowDialPlan", { Context: context });

	return events
		.filter((event) => event.Event === "ListDialplan" && event.Context === context)
		.map((event) => ({
			extension: event.Extension ?? "",
			priority: Number.parseInt(event.Priority ?? "0", 10),
			application: event.Application ?? "",
			appData: event.AppData ?? "",
		}));
}

describeLive("dialplan", () => {
	for (const context of EXPECTED_CONTEXTS) {
		test(`context [${context}] exists and has extensions`, async () => {
			const lines = await showDialplan(context);

			expect(lines.length).toBeGreaterThan(0);
		});
	}

	test("extension 900 in the tenant context hands the caller to Stasis WITH ITS TENANT", async () => {
		const lines = await showDialplan(TENANT_CONTEXTS.internal);
		const nineHundred = lines.filter((line) => line.extension === "900");

		expect(nineHundred.length).toBeGreaterThan(0);

		const stasis = nineHundred.find((line) => line.application === "Stasis");

		expect(stasis).toBeDefined();
		// The dialplan uses a global so the app name is configured in one place.
		expect(stasis?.appData).toContain("AI_STASIS_APP");
		// And it STATES the tenant. This argument is what becomes calls.tenant_id and is
		// inherited by the contact, the transcript, the recording and the ticket; without
		// it the backend has to guess, and guessing is a cross-customer data leak.
		expect(stasis?.appData).toContain("tenant=");
	});

	test("every pre-tenancy context forwards into the legacy tenant's own context", async () => {
		// They are kept because things outside the dialplan still say them: a softphone
		// provisioned before tenancy, the runbook's smoke commands, and the backend's
		// fallback. Forwarding rather than duplicating means a call arriving through an
		// old name is still attributed to a customer.
		for (const context of LEGACY_CONTEXTS) {
			const lines = await showDialplan(context);
			const gotos = lines.filter((line) => line.application === "Goto");

			expect(gotos.length).toBeGreaterThan(0);
			expect(gotos.some((line) => line.appData.includes("LEGACY_TENANT_SLUG"))).toBe(true);
		}
	});

	test("the AI_STASIS_APP global matches ASTERISK_ARI_APP", async () => {
		// If these drift, Stasis() sends the call to an application the backend
		// never subscribed to and the caller hears nothing at all.
		const packet = await ami.action("Getvar", { Variable: "AI_STASIS_APP" });

		expect(packet.Value).toBe(ARI_APP);
	});

	test("the diagnostic extensions 600, 601 and 602 are still there", async () => {
		const lines = await showDialplan(TENANT_CONTEXTS.internal);
		const extensions = new Set(lines.map((line) => line.extension));

		expect(extensions.has("600")).toBe(true);
		expect(extensions.has("601")).toBe(true);
		expect(extensions.has("602")).toBe(true);
	});

	test("the tenant's external context sends inbound calls to Stasis with its tenant", async () => {
		const lines = await showDialplan(TENANT_CONTEXTS.external);
		const stasis = lines.find((line) => line.application === "Stasis");

		expect(stasis).toBeDefined();
		expect(stasis?.appData).toContain("AI_STASIS_APP");
		// A carrier call arrives on THIS customer's trunk, so the tenant is known before
		// the backend has seen the channel.
		expect(stasis?.appData).toContain("tenant=");
	});

	test("the tenant bridge records first, then hands the channel to AudioSocket", async () => {
		const lines = await showDialplan(TENANT_CONTEXTS.aiBridge);
		const start = lines
			.filter((line) => line.extension === "s")
			.sort((left, right) => left.priority - right.priority);
		const mixMonitor = start.find((line) => line.application === "MixMonitor");
		const audioSocket = start.find((line) => line.application === "AudioSocket");

		expect(mixMonitor).toBeDefined();
		expect(audioSocket).toBeDefined();
		// Order matters: recording must be armed before the media path is handed over.
		expect(mixMonitor?.priority ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
			audioSocket?.priority ?? 0
		);
		// AudioSocket(<uuid>,<host:port>) - the backend sets both variables before
		// calling continueInDialplan.
		expect(audioSocket?.appData).toContain("AS_UUID");
		expect(audioSocket?.appData).toContain("AS_HOST");
		// The recording goes into the TENANT's own directory. One flat directory would
		// put one customer's audio next to another's, and the route that serves it cannot
		// require a header - so the directory is the boundary. The path is assembled one
		// priority earlier into MIXMON_FILE, so the tenant is asserted there.
		const mixmonFile = start.find(
			(line) => line.application === "Set" && line.appData.startsWith("MIXMON_FILE=")
		);

		expect(mixmonFile?.appData).toContain("TENANT_SLUG");
	});

	test("the tenant bridge refuses to run when the backend did not set the variables", async () => {
		const lines = await showDialplan(TENANT_CONTEXTS.aiBridge);
		const guards = lines.filter((line) => line.application === "GotoIf");

		expect(guards.length).toBeGreaterThanOrEqual(2);
		expect(guards.some((line) => line.appData.includes("AS_UUID"))).toBe(true);
		expect(guards.some((line) => line.appData.includes("AS_HOST"))).toBe(true);
		expect(lines.some((line) => line.extension === "missing")).toBe(true);
	});

	test("the tenant transfer context dials THIS customer's own endpoint", async () => {
		const lines = await showDialplan(TENANT_CONTEXTS.aiTransfer);
		const dial = lines.find((line) => line.application === "Dial");

		expect(dial).toBeDefined();
		// EVERY Dial in the context names the tenant - either through ${TENANT_SLUG} in an
		// inherited template line, or as a literal `<slug>-<ext>` in a generated line for
		// an extension the templates' patterns do not cover. Never bare digits: "101" is
		// an operator code every customer has, so a transfer to `PJSIP/101` could ring the
		// wrong company's operator and hand them a stranger's caller.
		const dials = lines.filter((line) => line.application === "Dial");

		expect(dials.length).toBeGreaterThan(0);

		for (const line of dials) {
			expect(line.appData).toContain("PJSIP/");
			expect(
				line.appData.includes("PJSIP/${TENANT_SLUG}-") || line.appData.includes(`PJSIP/${LEGACY_SLUG}-`)
			).toBe(true);
		}
	});

	test("the tenant click-to-call context dials out and matches any number", async () => {
		const lines = await showDialplan(TENANT_CONTEXTS.clickToCall);
		const dial = lines.find((line) => line.application === "Dial");

		expect(lines.some((line) => line.extension.startsWith("_"))).toBe(true);
		expect(dial).toBeDefined();
	});

	test("the recordings directory the dialplan writes to is the configured one", async () => {
		const packet = await ami.action("Getvar", { Variable: "RECORDINGS_DIR" });

		expect(packet.Value).toBe(RECORDINGS_DIR);
	});
});

// ===========================================
// Modules
// ===========================================

describeLive("AudioSocket modules", () => {
	for (const moduleName of AUDIOSOCKET_MODULES) {
		test(`${moduleName} is loaded`, async () => {
			const packet = await ami.action("ModuleCheck", { Module: moduleName });

			expect(packet.Response).toBe("Success");
		});
	}

	test("ModuleCheck really does fail for a module that is not loaded", async () => {
		// Guards the three assertions above: without this, a broken ModuleCheck
		// that always answered Success would look like a passing suite.
		let caught: unknown = null;

		try {
			await ami.action("ModuleCheck", { Module: "res_definitely_not_loaded.so" });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(AmiActionError);
	});
});
