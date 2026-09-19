import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { VoiceProviderHandlers, VoiceSessionContext } from "@/lib/telephony/contracts";
import type { TenantId } from "@/lib/tenancy";
import {
	createDownsampler24kTo8k,
	OUTPUT_GAIN_MAX_DB,
	PRESENCE_MAX_DB,
	writeInt16LEArray,
} from "./codec";
import {
	createGeminiLiveProvider,
	GEMINI_DEFAULT_VOICE,
	GEMINI_VOICE_CATALOG,
	type GeminiLiveTuning,
	getGeminiLiveTuning,
	KNOWN_GEMINI_VOICES,
	phoneClarityLabel,
	resolveGeminiVoice,
} from "./gemini-live";
import { AGENT_DIALECTS, unconfiguredAgentProfile } from "./prompts";

/**
 * What these tests protect, all of it learned from the live API.
 *
 * 1. The voice list. Google accepts thirty prebuilt voices on this model and the
 *    provider used to allow fifteen, silently substituting the default for the
 *    rest - so a dashboard offering them was lying to the owner. A shrunk list is
 *    invisible in a diff and only shows up as "I chose Sulafat and it sounds the
 *    same".
 * 2. The setup frame. It is sent once and it is all-or-nothing: an unknown field
 *    closes the socket with 1007 during the handshake, which the caller
 *    experiences as a dropped call. enableAffectiveDialog and proactivity were
 *    both measured doing exactly that, so their absence is asserted rather than
 *    assumed.
 * 3. Standard speech always. The dialect setting is a comprehension aid: the
 *    session must arrive knowing what "kelvotti" means and must never be told to
 *    say it, whichever region the deployment picked.
 */

/** Every voice name the live API accepted on gemini-3.1-flash-live-preview. */
const MEASURED_VOICES = [
	"Achernar",
	"Achird",
	"Algenib",
	"Algieba",
	"Alnilam",
	"Aoede",
	"Autonoe",
	"Callirrhoe",
	"Charon",
	"Despina",
	"Enceladus",
	"Erinome",
	"Fenrir",
	"Gacrux",
	"Iapetus",
	"Kore",
	"Laomedeia",
	"Leda",
	"Orus",
	"Pulcherrima",
	"Puck",
	"Rasalgethi",
	"Sadachbia",
	"Sadaltager",
	"Schedar",
	"Sulafat",
	"Umbriel",
	"Vindemiatrix",
	"Zephyr",
	"Zubenelgenubi",
] as const;

/** A WebSocket the test drives: it records what was sent and injects frames. */
/** Any tenant will do here: these tests never read a settings row. */
const TEST_TENANT = "00000000-0000-4000-8000-000000000001" as TenantId;

class FakeSocket {
	readyState = 1;
	readonly sent: Record<string, unknown>[] = [];
	closed: { code: number; reason: string } | null = null;

	private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const existing = this.listeners.get(type) ?? [];
		existing.push(listener);
		this.listeners.set(type, existing);
	}

	send(payload: string): void {
		this.sent.push(JSON.parse(payload) as Record<string, unknown>);
	}

	close(code = 1000, reason = ""): void {
		this.closed = { code, reason };
		this.readyState = 3;
	}

	dispatch(type: string, event: unknown = {}): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}

	emit(message: Record<string, unknown>): void {
		this.dispatch("message", { data: JSON.stringify(message) });
	}
}

function buildContext(overrides: Partial<VoiceSessionContext> = {}): VoiceSessionContext {
	return {
		callId: "11111111-1111-4111-8111-111111111111",
		channelId: "PJSIP/test-0001",
		callerNumber: "+998901234567",
		language: "uz",
		contact: null,
		isReturningCaller: false,
		previousCallCount: 0,
		recentTickets: [],
		...overrides,
	};
}

function buildHandlers(): VoiceProviderHandlers {
	return {
		onReady: () => undefined,
		onAudio: () => undefined,
		onTranscript: () => undefined,
		onInterruption: () => undefined,
		onUsage: () => undefined,
		onError: () => undefined,
		onClose: () => undefined,
		onToolCall: async () => ({ ok: true }),
	};
}

/**
 * Bring a session up against a fake socket and return the setup frame.
 *
 * The handshake is driven from the factory, because start() reads the stored
 * settings before it opens the socket - there is no synchronous moment between
 * the two in which a test could dispatch "open" itself.
 */
async function startSession(options: {
	voice?: string;
	tuning?: Partial<GeminiLiveTuning>;
}): Promise<{ socket: FakeSocket; setup: Record<string, unknown>; raw: string }> {
	const socket = new FakeSocket();
	const provider = createGeminiLiveProvider({
		tenantId: TEST_TENANT,
		apiKey: "test-key",
		voice: options.voice,
		tuning: options.tuning,
		agentProfile: unconfiguredAgentProfile(),
		socketFactory: () => {
			queueMicrotask(() => {
				socket.dispatch("open");
				socket.emit({ setupComplete: {} });
			});

			return socket as unknown as WebSocket;
		},
	});

	await provider.start(buildContext(), buildHandlers());

	const frame = socket.sent.at(0);
	const setup = frame?.setup as Record<string, unknown> | undefined;

	if (setup === undefined) {
		throw new Error("the provider sent no setup frame");
	}

	return { socket, setup, raw: JSON.stringify(frame) };
}

/** One 24 kHz tone, as the model would emit it: PCM16 LE, ready to base64. */
function makeTone(hz: number, sampleCount: number, amplitude = 12_000): Buffer {
	const samples = new Int16Array(sampleCount);

	for (let i = 0; i < sampleCount; i++) {
		samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / 24_000));
	}

	return writeInt16LEArray(samples);
}

/** Largest magnitude in a slin buffer. */
function peakOf(pcm: Buffer): number {
	let peak = 0;

	for (let i = 0; i + 1 < pcm.length; i += 2) {
		peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
	}

	return peak;
}

/**
 * Run a session, push 24 kHz audio parts through it and collect what the caller
 * would have heard.
 *
 * This goes through the real provider rather than the chain directly, because
 * the thing worth protecting is the WIRING - a correct filter that nothing calls
 * sounds exactly like no filter at all.
 */
async function captureAudio(tuning: Partial<GeminiLiveTuning>, parts: Buffer[]): Promise<Buffer> {
	const socket = new FakeSocket();
	const heard: Buffer[] = [];

	const provider = createGeminiLiveProvider({
		tenantId: TEST_TENANT,
		apiKey: "test-key",
		tuning,
		agentProfile: unconfiguredAgentProfile(),
		socketFactory: () => {
			queueMicrotask(() => {
				socket.dispatch("open");
				socket.emit({ setupComplete: {} });
			});

			return socket as unknown as WebSocket;
		},
	});

	await provider.start(buildContext(), {
		...buildHandlers(),
		onAudio: (chunk: Buffer) => {
			heard.push(Buffer.from(chunk));
		},
	});

	for (const part of parts) {
		socket.emit({
			serverContent: {
				modelTurn: {
					parts: [
						{ inlineData: { mimeType: "audio/pcm;rate=24000", data: part.toString("base64") } },
					],
				},
			},
		});
	}

	return Buffer.concat(heard);
}

function generationConfigOf(setup: Record<string, unknown>): Record<string, unknown> {
	const config = setup.generationConfig;

	if (config === null || typeof config !== "object") {
		throw new Error("the setup frame carried no generationConfig");
	}

	return config as Record<string, unknown>;
}

function speechConfigOf(setup: Record<string, unknown>): Record<string, unknown> {
	const speech = generationConfigOf(setup).speechConfig;

	if (speech === null || typeof speech !== "object") {
		throw new Error("the setup frame carried no speechConfig");
	}

	return speech as Record<string, unknown>;
}

function voiceNameOf(setup: Record<string, unknown>): string {
	const voiceConfig = speechConfigOf(setup).voiceConfig as
		| { prebuiltVoiceConfig?: { voiceName?: string } }
		| undefined;

	return voiceConfig?.prebuiltVoiceConfig?.voiceName ?? "";
}

function vadOf(setup: Record<string, unknown>): Record<string, unknown> {
	const realtime = setup.realtimeInputConfig as
		| { automaticActivityDetection?: Record<string, unknown> }
		| undefined;
	const vad = realtime?.automaticActivityDetection;

	if (vad === undefined) {
		throw new Error("the setup frame carried no automaticActivityDetection");
	}

	return vad;
}

function instructionsOf(setup: Record<string, unknown>): string {
	const instruction = setup.systemInstruction as { parts?: Array<{ text?: string }> } | undefined;

	return instruction?.parts?.[0]?.text ?? "";
}

describe("the Gemini voice catalog", () => {
	test("offers every voice the live API accepted, and nothing it did not", () => {
		expect([...KNOWN_GEMINI_VOICES].sort()).toEqual([...MEASURED_VOICES].sort());
	});

	test("describes each voice, because thirty star names are unchoosable without it", () => {
		expect(GEMINI_VOICE_CATALOG).toHaveLength(MEASURED_VOICES.length);

		for (const option of GEMINI_VOICE_CATALOG) {
			expect(option.name.trim()).toBe(option.name);
			expect(option.character.length).toBeGreaterThan(0);
			expect(option.description.length).toBeGreaterThan(0);
		}
	});

	test("lists no voice twice and stays in step with the bare name list", () => {
		const names = GEMINI_VOICE_CATALOG.map((option) => option.name);

		expect(new Set(names).size).toBe(names.length);
		expect(names).toEqual([...KNOWN_GEMINI_VOICES]);
	});

	test("still allows the fifteen the old list held", () => {
		// The widening must not have replaced one arbitrary subset with another: a
		// business already configured with one of these keeps its voice.
		for (const voice of [
			"Aoede",
			"Autonoe",
			"Callirrhoe",
			"Charon",
			"Despina",
			"Enceladus",
			"Erinome",
			"Fenrir",
			"Kore",
			"Laomedeia",
			"Leda",
			"Orus",
			"Puck",
			"Umbriel",
			"Zephyr",
		]) {
			expect(resolveGeminiVoice(voice)).toBe(voice);
		}
	});
});

describe("resolveGeminiVoice", () => {
	test("accepts every catalogued name verbatim, including the newly allowed ones", () => {
		for (const option of GEMINI_VOICE_CATALOG) {
			expect(resolveGeminiVoice(option.name)).toBe(option.name);
		}
	});

	test("is case-insensitive, because a dashboard field is typed by a person", () => {
		expect(resolveGeminiVoice("sulafat")).toBe("Sulafat");
		expect(resolveGeminiVoice("ZUBENELGENUBI")).toBe("Zubenelgenubi");
	});

	test("falls back to the default rather than sending a name that kills the session", () => {
		// "cedar" is an OpenAI voice and reaches here from a profile configured
		// before the deployment switched provider. Sent up the socket it is
		// 1007 No matching speaker voice found - a dropped call.
		expect(resolveGeminiVoice("cedar")).toBe(GEMINI_DEFAULT_VOICE);
		expect(resolveGeminiVoice("alloy")).toBe(GEMINI_DEFAULT_VOICE);
		expect(resolveGeminiVoice("")).toBe(GEMINI_DEFAULT_VOICE);
		expect(resolveGeminiVoice(undefined)).toBe(GEMINI_DEFAULT_VOICE);
	});
});

describe("the setup frame", () => {
	test("sends a newly allowed voice through untouched", async () => {
		const { setup } = await startSession({ voice: "Sulafat", tuning: { voice: null } });

		expect(voiceNameOf(setup)).toBe("Sulafat");
	});

	test("prefers the voice the dashboard stored over the profile's", async () => {
		const { setup } = await startSession({ voice: "Zephyr", tuning: { voice: "Achird" } });

		expect(voiceNameOf(setup)).toBe("Achird");
	});

	test("substitutes the default for a voice the API would reject", async () => {
		const { setup } = await startSession({ voice: "cedar", tuning: { voice: null } });

		expect(voiceNameOf(setup)).toBe(GEMINI_DEFAULT_VOICE);
	});

	test("carries the generation knobs the model accepts", async () => {
		const { setup } = await startSession({
			tuning: { temperature: 0.7, topP: 0.9, maxOutputTokens: 1024 },
		});
		const config = generationConfigOf(setup);

		expect(config.responseModalities).toEqual(["AUDIO"]);
		expect(config.temperature).toBe(0.7);
		expect(config.topP).toBe(0.9);
		expect(config.maxOutputTokens).toBe(1024);
	});

	test("keeps the defaults inside the ranges the API accepts", async () => {
		const { setup } = await startSession({});
		const config = generationConfigOf(setup);

		expect(config.temperature as number).toBeGreaterThanOrEqual(0);
		expect(config.temperature as number).toBeLessThanOrEqual(2);
		expect(config.topP as number).toBeGreaterThan(0);
		expect(config.topP as number).toBeLessThanOrEqual(1);
	});

	test("sends no token cap when the setting is zero, rather than a cap of zero", async () => {
		// Zero is the registry's documented "no limit". Sending the literal 0 would
		// cap a spoken turn at nothing at all, and audio is counted in tokens.
		const uncapped = await startSession({ tuning: { maxOutputTokens: 0 } });

		expect(generationConfigOf(uncapped.setup).maxOutputTokens).toBeUndefined();
	});

	test("configures turn-taking with the two enum values the API knows", async () => {
		const { setup } = await startSession({});
		const vad = vadOf(setup);

		expect(["START_SENSITIVITY_LOW", "START_SENSITIVITY_HIGH"]).toContain(
			String(vad.startOfSpeechSensitivity)
		);
		expect(["END_SENSITIVITY_LOW", "END_SENSITIVITY_HIGH"]).toContain(
			String(vad.endOfSpeechSensitivity)
		);
		expect(typeof vad.prefixPaddingMs).toBe("number");
		expect(typeof vad.silenceDurationMs).toBe("number");
	});

	test("passes a configured turn-taking setting straight through", async () => {
		const { setup } = await startSession({
			tuning: {
				startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
				endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
				prefixPaddingMs: 400,
				silenceDurationMs: 900,
			},
		});

		expect(vadOf(setup)).toEqual({
			startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
			endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
			prefixPaddingMs: 400,
			silenceDurationMs: 900,
		});
	});

	test("compresses the context window, so a long call is not cut off when it fills", async () => {
		const { setup } = await startSession({});

		expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
	});

	test("sends no languageCode unless one was configured", async () => {
		const open = await startSession({ tuning: { languageCode: "" } });
		const pinned = await startSession({ tuning: { languageCode: "uz-UZ" } });

		expect(speechConfigOf(open.setup).languageCode).toBeUndefined();
		expect(speechConfigOf(pinned.setup).languageCode).toBe("uz-UZ");
	});

	test("keeps transcribing both sides, which is what the CRM record is made of", async () => {
		const { setup } = await startSession({});

		expect(setup.inputAudioTranscription).toEqual({});
		expect(setup.outputAudioTranscription).toEqual({});
	});

	test("declares the tools", async () => {
		const { setup } = await startSession({});
		const tools = setup.tools as Array<{ functionDeclarations?: Array<{ name: string }> }>;
		const names = tools[0]?.functionDeclarations?.map((declaration) => declaration.name) ?? [];

		expect(names).toContain("search_knowledge_base");
		expect(names).toContain("transfer_to_human");
	});

	test("never sends the two fields measured to close the socket with 1007", async () => {
		const { raw } = await startSession({});

		// Both belong to the native-audio models and are rejected by this one:
		//   Unknown name "enableAffectiveDialog" at 'setup'
		//   Unknown name "proactivity" at 'setup'
		// A rejected setup frame is a dropped call, so this is a hard guard rather
		// than a style preference.
		expect(raw).not.toContain("enableAffectiveDialog");
		expect(raw).not.toContain("enable_affective_dialog");
		expect(raw).not.toContain("proactivity");
	});
});

describe("the effective tuning", () => {
	test("never leaves a range the API accepts, whatever the database holds", async () => {
		// Reads the real registry and the real rows: this is the test that fails if a
		// setting is registered with a value this provider would send verbatim into a
		// 1007, which closes the socket before the caller hears anything.
		const tuning = await getGeminiLiveTuning(TEST_TENANT);

		expect(tuning.temperature).toBeGreaterThanOrEqual(0);
		expect(tuning.temperature).toBeLessThanOrEqual(2);
		expect(tuning.topP).toBeGreaterThanOrEqual(0);
		expect(tuning.topP).toBeLessThanOrEqual(1);
		expect(tuning.maxOutputTokens === 0 || tuning.maxOutputTokens >= 256).toBe(true);
		expect(tuning.maxOutputTokens).toBeLessThanOrEqual(32_768);
		expect(["START_SENSITIVITY_LOW", "START_SENSITIVITY_HIGH"]).toContain(
			tuning.startOfSpeechSensitivity
		);
		expect(["END_SENSITIVITY_LOW", "END_SENSITIVITY_HIGH"]).toContain(
			tuning.endOfSpeechSensitivity
		);
		expect(tuning.prefixPaddingMs).toBeGreaterThanOrEqual(0);
		expect(tuning.silenceDurationMs).toBeGreaterThan(0);
		expect(
			tuning.languageCode === "" || /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tuning.languageCode)
		).toBe(true);
	});

	test("resolves the dialect to one this build has a prompt block for", async () => {
		const tuning = await getGeminiLiveTuning(TEST_TENANT);

		expect(AGENT_DIALECTS.map((option) => option.id)).toContain(tuning.dialect);
	});
});

describe("dialect in a real session", () => {
	test("the session teaches the word forms even with no region chosen", async () => {
		// Pinned rather than left to resolve from system_settings, so a deployment
		// that simply used the feature cannot turn this assertion red. Understanding
		// is unconditional now: "neutral" means no region is emphasised, not that the
		// agent stops following an ordinary caller.
		const { setup } = await startSession({ tuning: { dialect: "neutral" } });
		const instructions = instructionsOf(setup);

		expect(instructions).toContain("# UNDERSTANDING A CALLER WHO SPEAKS IN SHEVA");
		expect(instructions).toContain('"kelvotti" / "kelotti" = kelayapti');
		expect(instructions).not.toContain("Most callers on this number are from");
	});

	test("choosing a region adds an emphasis line and nothing that tells it to speak sheva", async () => {
		const { setup } = await startSession({ tuning: { dialect: "xorazm" } });
		const instructions = instructionsOf(setup);

		expect(instructions).toContain("Most callers on this number are from Xorazm");
		expect(instructions).toContain("reply in clean, well-formed standard Uzbek");
		expect(instructions).not.toContain("Callers on this line speak");
	});
});

/**
 * What this provider can and cannot tell the platform about the caller.
 *
 * THE BUG BEHIND THIS. Call 6c5a2006-bd4c-47a0-96b1-f47dfe28b34b was hung up on a
 * caller who was talking: 31.6 s of caller audio, one agent turn (the greeting),
 * no caller transcript at all, cut exactly 20.0 s after the last activity of any
 * kind. Replaying that call's own recording into a live session showed why -
 * fifteen seconds of continuous speech produced ZERO server messages, and then one
 * inputTranscription carrying the whole utterance two seconds after the caller
 * stopped. Input transcription on this model is a turn-BOUNDARY event, so a guard
 * driven only by it cannot tell a talking caller from a silent line.
 *
 * The mid-turn signal is therefore measured from the caller's own frames, in
 * audiosocket.ts's CallerVoiceActivity - one detector, tested there against the
 * levels these calls actually carried. What this provider still owes the platform
 * is the turn-boundary event itself, which is the only evidence the words were
 * understood rather than merely heard.
 */
describe("the caller signal this provider does send", () => {
	test("the caller is reported when the model finally transcribes them", async () => {
		const socket = new FakeSocket();
		let signals = 0;

		const provider = createGeminiLiveProvider({
			tenantId: TEST_TENANT,
			apiKey: "test-key",
			agentProfile: unconfiguredAgentProfile(),
			socketFactory: () => {
				queueMicrotask(() => {
					socket.dispatch("open");
					socket.emit({ setupComplete: {} });
				});

				return socket as unknown as WebSocket;
			},
		});

		await provider.start(buildContext(), {
			...buildHandlers(),
			onCallerSpeech: () => {
				signals += 1;
			},
		});

		socket.emit({ serverContent: { inputTranscription: { text: "assalomu alaykum" } } });

		expect(signals).toBe(1);
	});

	test("pushing the caller's audio reports nothing on its own", async () => {
		// This file used to measure the same PCM the orchestrator measures, with a
		// different rule, and the two disagreed about what a noisy line meant. It now
		// forwards audio and says nothing about it.
		const socket = new FakeSocket();
		let signals = 0;

		const provider = createGeminiLiveProvider({
			tenantId: TEST_TENANT,
			apiKey: "test-key",
			agentProfile: unconfiguredAgentProfile(),
			socketFactory: () => {
				queueMicrotask(() => {
					socket.dispatch("open");
					socket.emit({ setupComplete: {} });
				});

				return socket as unknown as WebSocket;
			},
		});

		await provider.start(buildContext(), {
			...buildHandlers(),
			onCallerSpeech: () => {
				signals += 1;
			},
		});

		const loud = new Int16Array(160).fill(6500);

		for (let i = 0; i < 200; i++) {
			provider.pushAudio(writeInt16LEArray(loud));
		}

		expect(signals).toBe(0);
		// The audio itself still goes up, which is the only job left here.
		expect(provider.stats().inputAudioMs).toBe(200 * 20);
	});
});

describe("barge-in suppression", () => {
	/** A session whose interruptions can be counted. */
	async function startCountingSession(): Promise<{
		socket: FakeSocket;
		provider: Awaited<ReturnType<typeof createGeminiLiveProvider>>;
	}> {
		const socket = new FakeSocket();
		const provider = createGeminiLiveProvider({
			tenantId: TEST_TENANT,
			apiKey: "test-key",
			agentProfile: unconfiguredAgentProfile(),
			socketFactory: () => {
				queueMicrotask(() => {
					socket.dispatch("open");
					socket.emit({ setupComplete: {} });
				});

				return socket as unknown as WebSocket;
			},
		});

		await provider.start(buildContext(), buildHandlers());

		return { socket, provider };
	}

	test("the closing line cannot be interrupted", async () => {
		const { socket, provider } = await startCountingSession();

		socket.emit({ serverContent: { interrupted: true } });
		expect(provider.stats().interruptions).toBe(1);

		provider.suppressBargeIn?.();
		socket.emit({ serverContent: { interrupted: true } });
		expect(provider.stats().interruptions).toBe(1);
	});

	test("suppression ends with the turn it was protecting, not with the call", async () => {
		// "Announce, then act" does not always end the call: a transfer that reaches
		// no operator hands the caller back to the agent to take a message instead.
		// While this was a one-way latch, that caller could not interrupt the agent
		// again for the rest of the call.
		const { socket, provider } = await startCountingSession();

		provider.suppressBargeIn?.();
		socket.emit({ serverContent: { interrupted: true } });
		expect(provider.stats().interruptions).toBe(0);

		socket.emit({ serverContent: { turnComplete: true } });
		socket.emit({ serverContent: { interrupted: true } });

		expect(provider.stats().interruptions).toBe(1);
	});
});

describe("tool calls reach the orchestrator", () => {
	/**
	 * The regression this exists for.
	 *
	 * The call site handed `validateToolArguments` a JSON STRING while the
	 * validators zod-parse an object, so every tool call this provider ever made
	 * was rejected with "expected object, received string" - behind a warn log
	 * nobody read. The AI appeared to work: it said it had written the request
	 * down, and nothing was written. Validating in isolation passed, because the
	 * bug was at the seam; only driving a realistic `toolCall` frame end to end
	 * catches it.
	 */
	async function sessionWithToolSpy(): Promise<{
		socket: FakeSocket;
		seen: { name: string; args: Record<string, unknown> }[];
	}> {
		const socket = new FakeSocket();
		const seen: { name: string; args: Record<string, unknown> }[] = [];
		const provider = createGeminiLiveProvider({
			tenantId: TEST_TENANT,
			apiKey: "test-key",
			agentProfile: unconfiguredAgentProfile(),
			socketFactory: () => {
				queueMicrotask(() => {
					socket.dispatch("open");
					socket.emit({ setupComplete: {} });
				});

				return socket as unknown as WebSocket;
			},
		});

		await provider.start(buildContext(), {
			...buildHandlers(),
			onToolCall: async (request) => {
				seen.push({ name: request.name, args: request.args as Record<string, unknown> });

				return { ok: true };
			},
		});

		return { socket, seen };
	}

	test("a realistic toolCall frame is accepted and forwarded", async () => {
		const { socket, seen } = await sessionWithToolSpy();

		// The shape Gemini actually sends: args already parsed, not a JSON string.
		socket.emit({
			toolCall: {
				functionCalls: [
					{
						id: "fc-1",
						name: "add_note",
						args: { content: "Mijoz ertaga qayta qo'ng'iroq qiladi" },
					},
				],
			},
		});

		// handleToolCalls is deliberately not awaited by the socket callback, so let
		// the microtask queue drain.
		await Bun.sleep(20);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.name).toBe("add_note");
		expect(seen[0]?.args.content).toBe("Mijoz ertaga qayta qo'ng'iroq qiladi");
	});

	test("a genuinely malformed argument is still refused", async () => {
		// The fix must not turn the validator off: a missing required field has to
		// come back as an error the model can read, not reach the orchestrator.
		const { socket, seen } = await sessionWithToolSpy();

		socket.emit({
			toolCall: { functionCalls: [{ id: "fc-2", name: "add_note", args: {} }] },
		});

		await Bun.sleep(20);

		expect(seen).toHaveLength(0);
	});
});

describe("phone clarity, measured per voice", () => {
	test("most of the catalogue is measured, and the rest says so", () => {
		// This deliberately does NOT demand a figure for every voice. The version
		// that did was satisfied by publishing single-render numbers next to
		// twice-rendered ones, which sorted the picker on noise. Seven voices have
		// one render each and carry null until somebody renders them again.
		const measured = GEMINI_VOICE_CATALOG.filter((option) => option.phoneClarityDb !== null);

		expect(measured.length).toBeGreaterThanOrEqual(GEMINI_VOICE_CATALOG.length / 2);

		for (const option of GEMINI_VOICE_CATALOG) {
			if (option.phoneClarityDb !== null) {
				continue;
			}

			// An unmeasured voice must be visibly unmeasured, never a default figure.
			expect({ voice: option.name, label: option.phoneClarity }).toEqual({
				voice: option.name,
				label: phoneClarityLabel(null),
			});
		}
	});

	test("the figures are consonant-to-vowel ratios, not decoration", () => {
		for (const option of GEMINI_VOICE_CATALOG) {
			const clarityDb = option.phoneClarityDb;

			if (clarityDb === null) {
				continue;
			}

			// Speech always has more energy in the vowel band than above it, so the
			// ratio is negative; and a voice 30 dB down would be unusable, not dull.
			expect({ voice: option.name, plausible: clarityDb < 0 && clarityDb > -30 }).toEqual({
				voice: option.name,
				plausible: true,
			});
			expect(option.phoneClarity).toBe(phoneClarityLabel(clarityDb));
		}
	});

	test("the spread is wide enough to be worth showing at all", () => {
		const values = GEMINI_VOICE_CATALOG.map((option) => option.phoneClarityDb ?? 0);
		const spread = Math.max(...values) - Math.min(...values);

		// Measured at 13 dB. If a re-measurement ever collapsed this to a couple of
		// dB the column would be noise dressed as advice and should come out.
		expect(spread).toBeGreaterThan(6);
	});

	test("an unmeasured voice says so instead of being given a number", () => {
		expect(phoneClarityLabel(null)).toBe("O'lchanmagan");
		expect(phoneClarityLabel(-5)).toBe("Telefonda tiniq");
		expect(phoneClarityLabel(-10)).toBe("Telefonda o'rtacha");
		expect(phoneClarityLabel(-17)).toBe("Telefonda bo'g'iq");
	});

	test("the bands are wider than the measurement error, so they do not flicker", () => {
		// A published figure carries about 1.4 dB of standard error. A band narrower
		// than roughly 4 dB would move a voice between labels on noise alone, which
		// reads as "my voice changed" when nothing did.
		const boundaries = [-8, -12];

		for (const boundary of boundaries) {
			expect(phoneClarityLabel(boundary)).not.toBe(phoneClarityLabel(boundary - 1));
		}

		expect(Math.abs(boundaries[0] - boundaries[1])).toBeGreaterThanOrEqual(4);
	});
});

describe("the outbound audio chain", () => {
	test("defaults to the presence lift the measurements support", async () => {
		const tuning = await getGeminiLiveTuning(TEST_TENANT);

		// Both are clamped to what the DSP will accept, whatever the database says.
		expect(tuning.presenceDb).toBeGreaterThanOrEqual(0);
		expect(tuning.presenceDb).toBeLessThanOrEqual(PRESENCE_MAX_DB);
		expect(tuning.outputGainDb).toBeGreaterThanOrEqual(0);
		expect(tuning.outputGainDb).toBeLessThanOrEqual(OUTPUT_GAIN_MAX_DB);
	});

	test("the agent's voice is filtered on the way to the caller", async () => {
		const pcm24k = makeTone(2100, 4800);

		const lifted = await captureAudio({ presenceDb: 6, outputGainDb: 3 }, [pcm24k]);
		const plain = createDownsampler24kTo8k().process(pcm24k);

		expect(lifted.length).toBe(plain.length);
		// 2.1 kHz is the centre of the bell, so this tone MUST come out louder. If
		// it does not, the chain is wired up but not running.
		expect(peakOf(lifted)).toBeGreaterThan(peakOf(plain) * 1.5);
	});

	test("turning both knobs off restores the raw downsample, byte for byte", async () => {
		const pcm24k = makeTone(2100, 4800);

		const off = await captureAudio({ presenceDb: 0, outputGainDb: 0 }, [pcm24k]);

		expect(off.equals(createDownsampler24kTo8k().process(pcm24k))).toBe(true);
	});

	test("one chain per call, not one per audio part", async () => {
		// The model sends a spoken answer as a burst of base64 parts. Every stage in
		// the chain carries state across samples, so processing them separately has
		// to give the same bytes as processing the whole utterance at once -
		// otherwise each part begins with a few ms of wrong audio, dozens of times a
		// second. This is the regression that a one-shot resampler used to cause.
		const whole = makeTone(700, 7200);
		const parts = [whole.subarray(0, 1918), whole.subarray(1918, 5001), whole.subarray(5001)];

		const streamed = await captureAudio({ presenceDb: 6, outputGainDb: 3 }, parts);
		const atOnce = await captureAudio({ presenceDb: 6, outputGainDb: 3 }, [whole]);

		expect(streamed.equals(atOnce)).toBe(true);
	});
});
