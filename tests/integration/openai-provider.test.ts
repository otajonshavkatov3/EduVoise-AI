/**
 * The OpenAI Realtime provider, and the fallback decision built on top of it.
 *
 * The awkward fact this suite is designed around: **this project's API key has
 * no Realtime entitlement**. Every realtime model answers `model_not_found`, and
 * standalone STT/TTS return 403. That is not a bug to be hidden - it is the
 * current production reality, and the code's job is to detect it, say so
 * clearly, and fall back to the IVR while the caller is still on the line.
 *
 * So the assertions are written as invariants rather than as "expect false":
 *
 *   available === false  ->  the factory must hand out fallback-ivr, and the
 *                            detail must explain why in terms an operator can act on.
 *   available === true   ->  the factory must hand out openai-realtime.
 *
 * Both branches are asserted, so the day the account is upgraded this file keeps
 * passing and starts proving the opposite path instead.
 *
 * The wire shape is tested against a local WebSocket server rather than against
 * OpenAI: that is the only way to assert what the client *sends* - in particular
 * that it never sends the `OpenAI-Beta` header, which the GA endpoint rejects
 * outright with `beta_api_shape_disabled`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

import type { TenantId } from "../../apps/backend/src/lib/tenancy";
import {
	createOpenAiRealtimeProvider,
	FALLBACK_IVR_PROVIDER_NAME,
	GEMINI_LIVE_PROVIDER_NAME,
	OPENAI_REALTIME_PROVIDER_NAME,
	probeOpenAiRealtime,
	probeProviderHealth,
	resetVoiceProviderHealthCache,
	resolveVoiceProvider,
	VoiceProviderUnavailableError,
	type VoiceProviderHandlers,
	type VoiceSessionContext,
} from "../../apps/backend/src/lib/ai";

/** Provider SELECTION reads env and the profile, never a settings row, so any id works. */
const TEST_TENANT = "00000000-0000-4000-8000-000000000001" as TenantId;

// ===========================================
// Fixtures
// ===========================================

const PROBE_TIMEOUT_MS = 10_000;
/** The real probe opens a socket to OpenAI and then checks /v1/models. */
const LIVE_PROBE_TEST_TIMEOUT_MS = 45_000;
const FAKE_TIMEOUT_MS = 4_000;

const SOURCE_PATH = `${import.meta.dir}/../../apps/backend/src/lib/ai/openai-realtime.ts`;

const SESSION_CONTEXT: VoiceSessionContext = {
	callId: "11111111-1111-4111-8111-111111111111",
	channelId: "PJSIP/101-00000001",
	callerNumber: "+998901234567",
	language: "uz",
	contact: null,
	isReturningCaller: false,
	previousCallCount: 0,
	recentTickets: [],
};

function silentHandlers(): VoiceProviderHandlers {
	return {
		onReady() {},
		onAudio() {},
		onTranscript() {},
		async onToolCall() {
			return {};
		},
		onInterruption() {},
		onUsage() {},
		onError() {},
		onClose() {},
	};
}

// ===========================================
// Fake Realtime endpoint
// ===========================================

type FakeMode = "created" | "error" | "close";

interface Upgrade {
	url: string;
	headers: Record<string, string>;
}

interface FakeRealtime {
	baseUrl: string;
	readonly upgrades: Upgrade[];
	/** Client -> server events, parsed. */
	readonly received: Array<Record<string, unknown>>;
	stop(): void;
}

const MODEL_NOT_FOUND_EVENT = {
	type: "error",
	error: {
		type: "invalid_request_error",
		code: "model_not_found",
		message: "The model `gpt-realtime` does not exist or you do not have access to it.",
	},
};

/**
 * A local stand-in for wss://api.openai.com/v1/realtime.
 *
 * `created` behaves like an account that works: it answers `session.created`,
 * then echoes `session.updated` once the client configures the session.
 * `error` behaves like this project's account today. `close` behaves like a
 * network that drops the upgrade.
 */
function startFakeRealtime(mode: FakeMode): FakeRealtime {
	const upgrades: Upgrade[] = [];
	const received: Array<Record<string, unknown>> = [];

	const server = Bun.serve({
		port: 0,
		fetch(request, self) {
			const headers: Record<string, string> = {};

			request.headers.forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
			upgrades.push({ url: request.url, headers });

			if (self.upgrade(request)) {
				return undefined;
			}

			return new Response("expected a websocket upgrade", { status: 400 });
		},
		websocket: {
			open(ws: ServerWebSocket<unknown>) {
				if (mode === "created") {
					ws.send(JSON.stringify({ type: "session.created", session: { id: "sess_fake" } }));
					return;
				}
				if (mode === "error") {
					ws.send(JSON.stringify(MODEL_NOT_FOUND_EVENT));
					return;
				}
				ws.close(1011, "fake outage");
			},
			message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
				let parsed: Record<string, unknown>;

				try {
					parsed = JSON.parse(String(message)) as Record<string, unknown>;
				} catch {
					return;
				}

				received.push(parsed);

				if (mode === "created" && parsed.type === "session.update") {
					ws.send(JSON.stringify({ type: "session.updated", session: parsed.session }));
				}
			},
		},
	});

	return {
		baseUrl: `ws://127.0.0.1:${server.port}/v1/realtime`,
		upgrades,
		received,
		stop() {
			server.stop(true);
		},
	};
}

/** Restores process.env after the configuration tests. */
function withEnv<T>(patch: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
	const previous = new Map<string, string | undefined>();

	for (const [key, value] of Object.entries(patch)) {
		previous.set(key, process.env[key]);

		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	resetVoiceProviderHealthCache();

	return body().finally(() => {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}

		resetVoiceProviderHealthCache();
	});
}

afterEach(() => {
	resetVoiceProviderHealthCache();
});

// ===========================================
// The real account
// ===========================================

describe("probeProviderHealth against the configured OpenAI account", () => {
	test(
		"reports a coherent verdict, and explains a missing entitlement",
		async () => {
			// Pinned to the OpenAI path: the probe now follows AI_VOICE_PROVIDER,
			// and this deployment's .env selects Gemini. Asserting the OpenAI
			// verdict therefore has to ask for the OpenAI provider explicitly.
			await withEnv({ AI_VOICE_PROVIDER: undefined }, async () => {
				const health = await probeProviderHealth({ force: true, timeoutMs: PROBE_TIMEOUT_MS });
				const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
				const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();

				expect([OPENAI_REALTIME_PROVIDER_NAME, FALLBACK_IVR_PROVIDER_NAME]).toContain(
					health.provider
				);
				expect(health.detail.trim().length).toBeGreaterThan(0);

				if (apiKey.length > 0) {
					// A health string ends up on a dashboard; it must never carry the key.
					expect(health.detail).not.toContain(apiKey);
				}

				if (health.available) {
					// The account has Realtime access: the AI must serve the next call.
					expect(health.provider).toBe(OPENAI_REALTIME_PROVIDER_NAME);
					return;
				}

				// No Realtime entitlement.
				expect(health.provider).toBe(FALLBACK_IVR_PROVIDER_NAME);
				// The reason must name the model and say something actionable about
				// access, not just "the socket closed".
				expect(health.detail).toContain(model);
				expect(health.detail).toMatch(
					/access|does not exist|not found|quota|api key|entitl|switched off|not set/i
				);
				// And it must tell the operator what happens to callers meanwhile.
				expect(health.detail).toMatch(/fallback|operator|IVR/i);
			});
		},
		LIVE_PROBE_TEST_TIMEOUT_MS
	);

	test(
		"the factory hands out exactly the provider the verdict implies",
		async () => {
			// Pinned to the OpenAI path so the assertion below is about that
			// backend specifically; the probe follows AI_VOICE_PROVIDER, and the
			// Gemini selection is asserted separately below.
			await withEnv({ AI_VOICE_PROVIDER: undefined }, async () => {
				const health = await probeProviderHealth({ force: true, timeoutMs: PROBE_TIMEOUT_MS });
				const provider = await resolveVoiceProvider({ tenantId: TEST_TENANT, probe: true });

				expect(provider.name).toBe(health.provider);
				expect(provider.name).toBe(
					health.available ? OPENAI_REALTIME_PROVIDER_NAME : FALLBACK_IVR_PROVIDER_NAME
				);
			});
		},
		LIVE_PROBE_TEST_TIMEOUT_MS
	);

	test(
		"the verdict is cached, so a polling dashboard cannot hammer OpenAI",
		async () => {
			const first = await probeProviderHealth({ force: true, timeoutMs: PROBE_TIMEOUT_MS });
			const startedAt = Date.now();
			const second = await probeProviderHealth();

			expect(second).toEqual(first);
			// A cache hit is a synchronous return, not another network round trip.
			expect(Date.now() - startedAt).toBeLessThan(200);
		},
		LIVE_PROBE_TEST_TIMEOUT_MS
	);
});

// ===========================================
// Configuration-driven selection
// ===========================================

describe("provider selection follows configuration without probing", () => {
	test("AI_AGENT_ENABLED=false switches the agent off entirely", async () => {
		await withEnv({ AI_AGENT_ENABLED: "false" }, async () => {
			const health = await probeProviderHealth({ force: true });
			const provider = await resolveVoiceProvider({ tenantId: TEST_TENANT });

			expect(health.available).toBe(false);
			expect(health.provider).toBe(FALLBACK_IVR_PROVIDER_NAME);
			expect(health.detail).toContain("AI_AGENT_ENABLED");
			expect(provider.name).toBe(FALLBACK_IVR_PROVIDER_NAME);
		});
	});

	test("a missing OPENAI_API_KEY is reported without a network call", async () => {
		await withEnv({ AI_AGENT_ENABLED: "true", AI_VOICE_PROVIDER: undefined, OPENAI_API_KEY: undefined }, async () => {
			const startedAt = Date.now();
			const health = await probeProviderHealth({ force: true });

			expect(health.available).toBe(false);
			expect(health.provider).toBe(FALLBACK_IVR_PROVIDER_NAME);
			expect(health.detail).toContain("OPENAI_API_KEY");
			// No socket was opened, so this must be immediate.
			expect(Date.now() - startedAt).toBeLessThan(200);
			expect((await resolveVoiceProvider({ tenantId: TEST_TENANT })).name).toBe(FALLBACK_IVR_PROVIDER_NAME);
		});
	});

	test("without probing, an enabled agent with a key gets the OpenAI provider", async () => {
		// This is the hot path: probing costs a round trip while the caller is
		// listening to ringback, so resolveVoiceProvider({ tenantId: TEST_TENANT }) does not probe by
		// default and the provider itself fails fast in start().
		await withEnv({ AI_AGENT_ENABLED: "true", AI_VOICE_PROVIDER: undefined, OPENAI_API_KEY: "sk-test-not-used" }, async () => {
			const startedAt = Date.now();
			const provider = await resolveVoiceProvider({ tenantId: TEST_TENANT });

			expect(provider.name).toBe(OPENAI_REALTIME_PROVIDER_NAME);
			expect(Date.now() - startedAt).toBeLessThan(200);
		});
	});

	test("AI_VOICE_PROVIDER=gemini switches the voice without touching anything else", async () => {
		await withEnv(
			{
				AI_AGENT_ENABLED: "true",
				AI_VOICE_PROVIDER: "gemini",
				GOOGLE_AI_API_KEY: "test-google-key",
			},
			async () => {
				expect((await resolveVoiceProvider({ tenantId: TEST_TENANT })).name).toBe(GEMINI_LIVE_PROVIDER_NAME);
			}
		);
	});

	test("the health probe names the provider that will answer, not always OpenAI", async () => {
		// The bug this pins: probeProviderHealth() used to talk to OpenAI whatever
		// AI_VOICE_PROVIDER said, so a Gemini deployment saw a status card naming
		// openai-realtime and an "available" measured against an API no call ever
		// touched. Without a Google key the answer must be the fallback - never the
		// other vendor's verdict.
		await withEnv(
			{
				AI_AGENT_ENABLED: "true",
				AI_VOICE_PROVIDER: "gemini",
				GOOGLE_AI_API_KEY: undefined,
				GEMINI_API_KEY: undefined,
			},
			async () => {
				const health = await probeProviderHealth({ force: true });

				expect(health.provider).not.toBe(OPENAI_REALTIME_PROVIDER_NAME);
				expect(health.provider).toBe(FALLBACK_IVR_PROVIDER_NAME);
				expect(health.available).toBe(false);
				expect(health.detail).toContain("GOOGLE_AI_API_KEY");
			}
		);
	});

	test("asking for Gemini without a Google key falls back rather than failing the call", async () => {
		// The dangerous version of this is a half-configured switch that drops calls.
		// A caller must always reach something, even if it is the scripted IVR.
		await withEnv(
			{
				AI_AGENT_ENABLED: "true",
				AI_VOICE_PROVIDER: "gemini",
				GOOGLE_AI_API_KEY: undefined,
				GEMINI_API_KEY: undefined,
			},
			async () => {
				expect((await resolveVoiceProvider({ tenantId: TEST_TENANT })).name).toBe(FALLBACK_IVR_PROVIDER_NAME);
			}
		);
	});
});

// ===========================================
// What goes onto the socket
// ===========================================

describe("the request the provider actually makes", () => {
	let fake: FakeRealtime | null = null;

	afterEach(() => {
		fake?.stop();
		fake = null;
	});

	test("sends only Authorization - never an OpenAI-Beta header", async () => {
		fake = startFakeRealtime("created");

		const provider = createOpenAiRealtimeProvider({
			apiKey: "sk-test-header-check",
			model: "gpt-realtime",
			baseUrl: fake.baseUrl,
			connectTimeoutMs: FAKE_TIMEOUT_MS,
		});

		await provider.start(SESSION_CONTEXT, silentHandlers());
		await provider.stop("test complete");

		expect(fake.upgrades).toHaveLength(1);

		const upgrade = fake.upgrades[0];

		if (!upgrade) {
			throw new Error("the fake endpoint recorded no upgrade request");
		}

		expect(upgrade.headers.authorization).toBe("Bearer sk-test-header-check");
		// "OpenAI-Beta: realtime=v1" is fatal on the GA endpoint
		// (beta_api_shape_disabled). Assert no vendor header at all, so a future
		// beta-flavoured header cannot creep back in either.
		expect(Object.keys(upgrade.headers).filter((name) => name.startsWith("openai-"))).toEqual([]);
		// The model belongs in the query string, not in a header.
		expect(new URL(upgrade.url).searchParams.get("model")).toBe("gpt-realtime");
	});

	test("the probe sends the same single header", async () => {
		fake = startFakeRealtime("created");

		const result = await probeOpenAiRealtime({
			apiKey: "sk-test-probe-header",
			model: "gpt-realtime",
			baseUrl: fake.baseUrl,
			timeoutMs: FAKE_TIMEOUT_MS,
		});

		expect(result.ok).toBe(true);
		expect(result.code).toBeNull();

		const upgrade = fake.upgrades[0];

		expect(upgrade?.headers.authorization).toBe("Bearer sk-test-probe-header");
		expect(Object.keys(upgrade?.headers ?? {}).filter((name) => name.startsWith("openai-"))).toEqual(
			[]
		);
	});

	test("configures the session in the GA shape", async () => {
		fake = startFakeRealtime("created");

		const provider = createOpenAiRealtimeProvider({
			apiKey: "sk-test-session-shape",
			model: "gpt-realtime",
			voice: "alloy",
			transcriptionModel: "whisper-1",
			baseUrl: fake.baseUrl,
			connectTimeoutMs: FAKE_TIMEOUT_MS,
		});

		await provider.start(SESSION_CONTEXT, silentHandlers());
		await provider.stop("test complete");

		const update = fake.received.find((event) => event.type === "session.update");

		expect(update).toBeDefined();

		const session = update?.session as {
			type?: string;
			output_modalities?: string[];
			instructions?: string;
			tools?: unknown[];
			tool_choice?: string;
			audio?: {
				input?: {
					format?: { type?: string };
					turn_detection?: { type?: string; threshold?: number; silence_duration_ms?: number };
					transcription?: { model?: string };
				};
				output?: { format?: { type?: string }; voice?: string };
			};
		};

		// GA shape: session.type, output_modalities and a nested audio object.
		// The dead beta shape had input_audio_format/output_audio_format at the
		// top level and no session.type, so these assertions pin the difference.
		expect(session.type).toBe("realtime");
		expect(session.output_modalities).toEqual(["audio"]);
		expect(session.tool_choice).toBe("auto");
		expect((session.tools ?? []).length).toBeGreaterThan(0);
		expect((session.instructions ?? "").length).toBeGreaterThan(0);

		// G.711 u-law in both directions: Asterisk's native telephony codec, so
		// no resampling happens anywhere in the bridge.
		expect(session.audio?.input?.format?.type).toBe("audio/pcmu");
		expect(session.audio?.output?.format?.type).toBe("audio/pcmu");

		// The voice and the transcription model are both deliberate choices that have
		// changed once already, so this asserts they are SET rather than pinning a
		// name a future tuning pass would have to come back and edit.
		expect((session.audio?.output?.voice ?? "").length).toBeGreaterThan(0);
		expect((session.audio?.input?.transcription?.model ?? "").length).toBeGreaterThan(0);

		// Semantic turn detection: a silence timer answers the first half of a
		// sentence, which showed up as three interrupted turns in one measured call.
		expect(session.audio?.input?.turn_detection?.type).toBe("semantic_vad");
	});

	test("no top-level beta audio fields are sent", async () => {
		fake = startFakeRealtime("created");

		const provider = createOpenAiRealtimeProvider({
			apiKey: "sk-test-no-beta-fields",
			baseUrl: fake.baseUrl,
			connectTimeoutMs: FAKE_TIMEOUT_MS,
		});

		await provider.start(SESSION_CONTEXT, silentHandlers());
		await provider.stop("test complete");

		const update = fake.received.find((event) => event.type === "session.update");
		const session = (update?.session ?? {}) as Record<string, unknown>;

		expect(session).not.toHaveProperty("input_audio_format");
		expect(session).not.toHaveProperty("output_audio_format");
		expect(session).not.toHaveProperty("input_audio_transcription");
		expect(session).not.toHaveProperty("turn_detection");
		expect(session).not.toHaveProperty("modalities");
	});
});

// ===========================================
// Failure handling
// ===========================================

describe("a refused account degrades instead of crashing", () => {
	let fake: FakeRealtime | null = null;

	afterEach(() => {
		fake?.stop();
		fake = null;
	});

	test("start() throws VoiceProviderUnavailableError on model_not_found", async () => {
		fake = startFakeRealtime("error");

		const provider = createOpenAiRealtimeProvider({
			apiKey: "sk-test-no-access",
			model: "gpt-realtime",
			baseUrl: fake.baseUrl,
			connectTimeoutMs: FAKE_TIMEOUT_MS,
		});

		let caught: unknown = null;

		try {
			await provider.start(SESSION_CONTEXT, silentHandlers());
		} catch (error) {
			caught = error;
		}

		// A typed error is the fallback signal the orchestrator branches on; a
		// plain Error would look like a bug and drop the caller.
		expect(caught).toBeInstanceOf(VoiceProviderUnavailableError);
		expect((caught as VoiceProviderUnavailableError).provider).toBe(
			OPENAI_REALTIME_PROVIDER_NAME
		);
		expect((caught as Error).message).toContain("model_not_found");
	});

	test("a dropped upgrade also produces the typed error, not a hang", async () => {
		fake = startFakeRealtime("close");

		const provider = createOpenAiRealtimeProvider({
			apiKey: "sk-test-outage",
			baseUrl: fake.baseUrl,
			connectTimeoutMs: FAKE_TIMEOUT_MS,
		});

		let caught: unknown = null;

		try {
			await provider.start(SESSION_CONTEXT, silentHandlers());
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(VoiceProviderUnavailableError);
	});

	test("the probe surfaces the error code rather than a bare failure", async () => {
		fake = startFakeRealtime("error");

		const result = await probeOpenAiRealtime({
			apiKey: "sk-test-no-access",
			model: "gpt-realtime",
			baseUrl: fake.baseUrl,
			timeoutMs: FAKE_TIMEOUT_MS,
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe("model_not_found");
		expect(result.model).toBe("gpt-realtime");
		expect(result.detail.length).toBeGreaterThan(0);
	});

	test("the probe reports a closed socket distinctly", async () => {
		fake = startFakeRealtime("close");

		const result = await probeOpenAiRealtime({
			apiKey: "sk-test-outage",
			baseUrl: fake.baseUrl,
			timeoutMs: FAKE_TIMEOUT_MS,
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe("closed");
	});

	test("the probe short-circuits when there is no key", async () => {
		const startedAt = Date.now();
		const result = await probeOpenAiRealtime({ apiKey: "", timeoutMs: FAKE_TIMEOUT_MS });

		expect(result.ok).toBe(false);
		expect(result.code).toBe("missing_api_key");
		expect(Date.now() - startedAt).toBeLessThan(200);
	});

	test("start() without a key fails fast with the typed error", async () => {
		const provider = createOpenAiRealtimeProvider({ apiKey: "" });

		let caught: unknown = null;

		try {
			await provider.start(SESSION_CONTEXT, silentHandlers());
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(VoiceProviderUnavailableError);
		expect((caught as Error).message).toContain("OPENAI_API_KEY");
	});
});

// ===========================================
// Source-level guard
// ===========================================

describe("the beta header is not in the source either", () => {
	/** Removes comments so the file's own prose about the dead beta shape is ignored. */
	function stripComments(source: string): string {
		return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
	}

	test("openai-realtime.ts contains no OpenAI-Beta outside comments", async () => {
		const source = await Bun.file(SOURCE_PATH).text();

		// The header comment does discuss "OpenAI-Beta: realtime=v1" on purpose,
		// so the runtime test above is the real guard and this one only ensures no
		// code path can send it.
		expect(source).toMatch(/OpenAI-Beta/i);
		expect(stripComments(source)).not.toMatch(/openai-beta/i);
		expect(stripComments(source)).toContain("Authorization");
	});
});

