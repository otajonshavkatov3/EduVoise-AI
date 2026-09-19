// biome-ignore-all lint/style/useNamingConvention: the event literals below are OpenAI Realtime wire payloads, so every snake_case field is spelled exactly as the API spells it.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { ActiveAgentProfile, KnowledgeHit } from "@/lib/ai-agent";
import type {
	VoiceProvider,
	VoiceProviderHandlers,
	VoiceSessionContext,
} from "@/lib/telephony/contracts";
import { muLawEncode } from "./codec";
import { createOpenAiRealtimeProvider } from "./openai-realtime";
import { unconfiguredAgentProfile } from "./prompts";

/**
 * Provider-level tests: the event handling, driven through a fake socket.
 *
 * No network and no API key. What is asserted here is the behaviour that was
 * wrong on a real call - a greeting stored twice, an agent that kept talking
 * over the caller, a silent gap around a tool call - so these are the tests that
 * fail if any of it comes back.
 */

interface SentEvent {
	type: string;
	[key: string]: unknown;
}

/** A WebSocket the test drives: it records what was sent and injects events. */
class FakeSocket implements Pick<WebSocket, "readyState" | "send" | "close"> {
	static readonly OPEN = 1;

	readyState = FakeSocket.OPEN;
	readonly sent: SentEvent[] = [];
	closed: { code: number; reason: string } | null = null;

	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;

	send(payload: string): void {
		this.sent.push(JSON.parse(payload) as SentEvent);
	}

	close(code = 1000, reason = ""): void {
		this.closed = { code, reason };
		this.readyState = 3;
	}

	/** Deliver one server event to the provider. */
	emit(event: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(event) });
	}

	sentOfType(type: string): SentEvent[] {
		return this.sent.filter((event) => event.type === type);
	}

	lastOfType(type: string): SentEvent | undefined {
		return this.sentOfType(type).at(-1);
	}
}

/** The `session` object out of a recorded session.update, without a cast. */
function sessionOf(event: SentEvent | undefined): Record<string, unknown> {
	const session = event?.session;

	if (session === null || typeof session !== "object") {
		throw new Error("the recorded event carried no session object");
	}

	return session as Record<string, unknown>;
}

/** The `session.audio.input` block of a recorded session.update. */
function inputOf(event: SentEvent | undefined): Record<string, unknown> {
	const audio = sessionOf(event).audio;

	if (audio === null || typeof audio !== "object") {
		throw new Error("the recorded session had no audio block");
	}

	const input = (audio as Record<string, unknown>).input;

	if (input === null || typeof input !== "object") {
		throw new Error("the recorded session had no audio.input block");
	}

	return input as Record<string, unknown>;
}

interface Recorded {
	transcripts: Array<{ role: string; content: string; isFinal: boolean }>;
	audioChunks: Buffer[];
	interruptions: number;
	/** Raw speech-start signals, which the silence guard depends on. */
	callerSpeech: number;
	usage: Array<{
		promptTokens?: number;
		completionTokens?: number;
		cachedTokens?: number;
		inputAudioTokens?: number;
		outputAudioTokens?: number;
	}>;
	errors: string[];
	closes: string[];
	readyCount: number;
	toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

function buildContext(): VoiceSessionContext {
	return {
		callId: "11111111-1111-4111-8111-111111111111",
		channelId: "PJSIP/test-0001",
		callerNumber: "+998901234567",
		language: "uz",
		contact: null,
		isReturningCaller: false,
		previousCallCount: 0,
		recentTickets: [],
	};
}

/**
 * Start a provider against a fake socket and bring the session up.
 *
 * `toolHandler` lets a test control how long a tool takes, which is the whole
 * point of the holding-line behaviour.
 */
async function startProvider(options: {
	toolHandler?: (name: string) => Promise<unknown>;
	toolAcknowledgementDelayMs?: number;
	ready?: boolean;
	/** The business the session answers for; omitted, the provider uses its defaults. */
	agentProfile?: ActiveAgentProfile;
	knowledge?: readonly KnowledgeHit[];
	context?: VoiceSessionContext;
	/** Exercises the server_vad fallback path without touching the environment. */
	turnDetectionMode?: string;
}): Promise<{ provider: VoiceProvider; socket: FakeSocket; recorded: Recorded }> {
	const socket = new FakeSocket();
	const recorded: Recorded = {
		transcripts: [],
		audioChunks: [],
		interruptions: 0,
		callerSpeech: 0,
		usage: [],
		errors: [],
		closes: [],
		readyCount: 0,
		toolCalls: [],
	};

	const handlers: VoiceProviderHandlers = {
		onReady: () => {
			recorded.readyCount += 1;
		},
		onAudio: (chunk) => {
			recorded.audioChunks.push(chunk);
		},
		onTranscript: (transcript) => {
			recorded.transcripts.push({
				role: transcript.role,
				content: transcript.content,
				isFinal: transcript.isFinal,
			});
		},
		onToolCall: async (call) => {
			recorded.toolCalls.push({ name: call.name, args: call.args });

			if (options.toolHandler === undefined) {
				return { ok: true };
			}

			return await options.toolHandler(call.name);
		},
		onInterruption: () => {
			recorded.interruptions += 1;
		},
		onCallerSpeech: () => {
			recorded.callerSpeech += 1;
		},
		onUsage: (usage) => {
			recorded.usage.push(usage);
		},
		onError: (error) => {
			recorded.errors.push(error.message);
		},
		onClose: (reason) => {
			recorded.closes.push(reason);
		},
	};

	const provider = createOpenAiRealtimeProvider({
		apiKey: "test-key",
		toolAcknowledgementDelayMs: options.toolAcknowledgementDelayMs,
		agentProfile: options.agentProfile,
		knowledge: options.knowledge,
		turnDetectionMode: options.turnDetectionMode,
		socketFactory: () => socket as unknown as WebSocket,
	});

	const started = provider.start(options.context ?? buildContext(), handlers);

	// The provider sends session.update on open, then waits for the echo.
	socket.onopen?.({});
	socket.emit({ type: "session.created", session: { id: "sess_1" } });

	if (options.ready !== false) {
		socket.emit({ type: "session.updated", session: { id: "sess_1" } });
		await started;
		// onReady is delivered in a microtask.
		await Promise.resolve();
	}

	return { provider, socket, recorded };
}

/** One agent turn: response.created, transcript deltas, then the final. */
function speakTurn(
	socket: FakeSocket,
	responseId: string,
	deltas: Array<{ text: string; atMs: number }>,
	transcript: string
): void {
	socket.emit({ type: "response.created", response: { id: responseId } });

	for (const delta of deltas) {
		setSystemTime(new Date(delta.atMs));
		socket.emit({
			type: "response.output_audio_transcript.delta",
			response_id: responseId,
			delta: delta.text,
		});
	}

	socket.emit({
		type: "response.output_audio_transcript.done",
		response_id: responseId,
		transcript,
	});
	socket.emit({ type: "response.done", response: { id: responseId, status: "completed" } });
}

afterEach(() => {
	setSystemTime();
});

describe("session configuration", () => {
	test("turn taking is decided semantically, not by a silence timer", async () => {
		const { socket } = await startProvider({});
		const update = socket.lastOfType("session.update");

		expect(update).toBeDefined();

		const turnDetection = inputOf(update).turn_detection as Record<string, unknown>;

		// A timer cannot tell "manzil..." (still thinking) from "manzil Chilonzor."
		// (finished), which is what produced three interrupted turns in one measured
		// call - each of them a reply generated, billed and never heard.
		expect(turnDetection.type).toBe("semantic_vad");
		// "auto", not "low". The most patient setting was tried first and read on a
		// real call as a hesitant agent taking a beat too long before every reply -
		// which a caller experiences as slow and dim, not careful. "auto" still waits
		// through a pause that sounds unfinished and answers straight away when the
		// sentence is plainly done.
		expect(turnDetection.eagerness).toBe("auto");
		expect(turnDetection.interrupt_response).toBe(true);
	});

	test("server_vad remains available and keeps its phone-line tuning", async () => {
		const { socket } = await startProvider({ turnDetectionMode: "server_vad" });
		const turnDetection = inputOf(socket.lastOfType("session.update")).turn_detection as Record<
			string,
			unknown
		>;

		expect(turnDetection.type).toBe("server_vad");
		expect(turnDetection.threshold).toBe(0.55);
		// 500 ms was cutting callers off between the parts of an address.
		expect(turnDetection.silence_duration_ms).toBe(700);
		expect(turnDetection.prefix_padding_ms).toBe(300);
	});

	test("the agent's reply is capped and paced for a narrowband line", async () => {
		const { socket } = await startProvider({});
		const update = socket.lastOfType("session.update");
		const session = (update as Record<string, unknown>).session as Record<string, unknown>;
		const output = (session.audio as Record<string, unknown>).output as Record<string, unknown>;

		// Generated speech is the most expensive thing on the bill and the only limit
		// a runaway turn can breach; the cap exists for when the prompt is not obeyed.
		expect(session.max_output_tokens).toBe(1200);
		// Slightly under one: 300-3400 Hz eats the consonants that carry Uzbek word
		// endings, and no amount of prompting buys that intelligibility back.
		expect(output.speed).toBe(0.95);
	});

	test("noise reduction and the transcription language are declared", async () => {
		const { socket } = await startProvider({});
		const input = inputOf(socket.lastOfType("session.update"));

		expect(input.noise_reduction).toEqual({ type: "near_field" });
		expect(input.transcription).toMatchObject({ language: "uz" });
	});

	test("the verified wire shape is unchanged: pcmu both ways, audio output", async () => {
		const { socket } = await startProvider({});
		const update = socket.lastOfType("session.update");
		const session = sessionOf(update);
		const audio = session.audio as { output: Record<string, unknown> };

		expect(session.type).toBe("realtime");
		expect(session.output_modalities).toEqual(["audio"]);
		expect(inputOf(update).format).toEqual({ type: "audio/pcmu" });
		expect(audio.output.format).toEqual({ type: "audio/pcmu" });
		expect(Array.isArray(session.tools)).toBe(true);
	});

	test("the business's profile drives the voice, the tools and the instructions", async () => {
		const profile: ActiveAgentProfile = {
			...unconfiguredAgentProfile(),
			id: "profile-1",
			isConfigured: true,
			businessName: "Salom Taksi",
			language: "uz",
			voice: "verse",
			ticketCategories: ["Buyurtma", "Shikoyat"],
		};
		const knowledge: KnowledgeHit[] = [
			{
				id: "k1",
				question: "Shahar tashqarisiga chiqasizmi?",
				answer: "Ha, viloyat ichida chiqamiz.",
				tags: [],
				priority: 5,
				score: 0,
			},
		];

		const { socket } = await startProvider({ agentProfile: profile, knowledge });
		const session = sessionOf(socket.lastOfType("session.update"));
		const audio = session.audio as { output: Record<string, unknown> };
		const tools = session.tools as Array<{
			name: string;
			parameters: { properties: Record<string, { enum?: string[] }> };
		}>;
		const createTicket = tools.find((tool) => tool.name === "create_ticket");

		// The voice the owner chose, not OPENAI_REALTIME_VOICE.
		expect(audio.output.voice).toBe("verse");
		expect(createTicket?.parameters.properties.category?.enum).toEqual(["Buyurtma", "Shikoyat"]);
		expect(tools.map((tool) => tool.name)).toContain("search_knowledge_base");
		expect(String(session.instructions)).toContain("Salom Taksi");
		expect(String(session.instructions)).toContain("Ha, viloyat ichida chiqamiz.");
	});

	test("no profile keeps the pre-profile behaviour instead of inventing a business", async () => {
		const { socket } = await startProvider({});
		const session = sessionOf(socket.lastOfType("session.update"));
		const audio = session.audio as { output: Record<string, unknown> };

		expect(audio.output.voice).toBe(process.env.OPENAI_REALTIME_VOICE ?? "alloy");
		expect(String(session.instructions)).toContain("nobody has configured this line yet");
	});

	test("an optional field the API rejects is dropped and the rest is re-sent", async () => {
		const { socket, recorded } = await startProvider({});

		expect(socket.sentOfType("session.update")).toHaveLength(1);

		socket.emit({
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "unknown_parameter",
				message: "Unknown parameter: 'session.audio.input.noise_reduction'.",
				param: "session.audio.input.noise_reduction",
			},
		});

		const updates = socket.sentOfType("session.update");

		expect(updates).toHaveLength(2);

		const retried = sessionOf(updates[1]);
		const retriedInput = inputOf(updates[1]);

		// The optional field is gone; the instructions and the tools are still there.
		expect(retriedInput.noise_reduction).toBeUndefined();
		expect(retriedInput.format).toEqual({ type: "audio/pcmu" });
		expect(typeof retried.instructions).toBe("string");
		// A dropped optional field is not a session error the dashboard should show.
		expect(recorded.errors).toHaveLength(0);
	});
});

describe("transcripts are stored once per turn", () => {
	test("a long agent turn produces one final line and no late interims", async () => {
		const { socket, recorded } = await startProvider({});
		const deltas: Array<{ text: string; atMs: number }> = [];

		// Six seconds of transcript deltas: the greeting that was stored twice.
		for (let index = 0; index < 60; index += 1) {
			deltas.push({ text: `so'z${index} `, atMs: 100_000 + index * 100 });
		}

		speakTurn(socket, "resp_1", deltas, "to'liq salomlashish matni");

		const agent = recorded.transcripts.filter((entry) => entry.role === "agent");
		const finals = agent.filter((entry) => entry.isFinal);
		const interims = agent.filter((entry) => !entry.isFinal);

		expect(finals).toHaveLength(1);
		expect(finals[0]?.content).toBe("to'liq salomlashish matni");

		// Interims still exist for the live view...
		expect(interims.length).toBeGreaterThan(1);

		// ...but none of them is a complete copy of the final line, which is what
		// the duplicated row was.
		for (const interim of interims) {
			expect(interim.content).not.toBe("to'liq salomlashish matni");
		}
	});

	test("a caller utterance with no deltas still lands as one final line", async () => {
		const { socket, recorded } = await startProvider({});

		socket.emit({
			type: "conversation.item.input_audio_transcription.completed",
			item_id: "item_1",
			transcript: "Suv kelmayapti",
		});

		const caller = recorded.transcripts.filter((entry) => entry.role === "caller");

		expect(caller).toEqual([{ role: "caller", content: "Suv kelmayapti", isFinal: true }]);
	});

	test("a duplicate .done for the same turn is not stored twice", async () => {
		const { socket, recorded } = await startProvider({});

		socket.emit({ type: "response.created", response: { id: "resp_1" } });
		socket.emit({
			type: "response.output_audio_transcript.done",
			response_id: "resp_1",
			transcript: "Assalomu alaykum!",
		});
		socket.emit({
			type: "response.output_audio_transcript.done",
			response_id: "resp_1",
			transcript: "Assalomu alaykum!",
		});

		const finals = recorded.transcripts.filter((entry) => entry.role === "agent" && entry.isFinal);

		expect(finals).toHaveLength(1);
	});
});

describe("barge-in", () => {
	/** 200 ms of agent audio, as the wire delivers it. */
	function audioDelta(socket: FakeSocket, responseId: string): void {
		const silence = Buffer.alloc(3_200); // 200 ms of slin8k
		const ulaw = muLawEncode(silence);

		socket.emit({
			type: "response.output_audio.delta",
			response_id: responseId,
			delta: ulaw.toString("base64"),
		});
	}

	test("stops the agent even when the model already finished generating", async () => {
		const { socket, recorded } = await startProvider({});

		setSystemTime(new Date(200_000));
		socket.emit({ type: "response.created", response: { id: "resp_1" } });

		// Four seconds of audio arrive in a burst, then generation completes. The
		// caller is still listening to it: this is the case an "is a response
		// active?" check misses entirely.
		for (let index = 0; index < 20; index += 1) {
			audioDelta(socket, "resp_1");
		}

		socket.emit({
			type: "response.output_audio_transcript.done",
			response_id: "resp_1",
			transcript: "Uzoq javob",
		});
		socket.emit({ type: "response.done", response: { id: "resp_1", status: "completed" } });

		expect(recorded.audioChunks.length).toBe(20);

		// One second later, while the agent is still audibly speaking, the caller
		// interrupts.
		setSystemTime(new Date(201_000));
		socket.emit({ type: "input_audio_buffer.speech_started" });

		expect(recorded.interruptions).toBe(1);
		expect(socket.sentOfType("response.cancel").length).toBeGreaterThanOrEqual(0);

		// Audio still on the wire for that response is dropped rather than played.
		audioDelta(socket, "resp_1");
		expect(recorded.audioChunks.length).toBe(20);
	});

	test("does not fire when the agent has finished being audible", async () => {
		const { socket, recorded } = await startProvider({});

		setSystemTime(new Date(300_000));
		socket.emit({ type: "response.created", response: { id: "resp_1" } });
		audioDelta(socket, "resp_1");
		socket.emit({ type: "response.done", response: { id: "resp_1", status: "completed" } });

		// Well after the 200 ms of audio has played out.
		setSystemTime(new Date(305_000));
		socket.emit({ type: "input_audio_buffer.speech_started" });

		expect(recorded.interruptions).toBe(0);
	});

	test("cancels the in-flight response and finalises what was said", async () => {
		const { socket, recorded } = await startProvider({});

		setSystemTime(new Date(400_000));
		socket.emit({ type: "response.created", response: { id: "resp_1" } });
		socket.emit({
			type: "response.output_audio_transcript.delta",
			response_id: "resp_1",
			delta: "Murojaatingizni ro'yxatga",
		});
		audioDelta(socket, "resp_1");

		setSystemTime(new Date(400_100));
		socket.emit({ type: "input_audio_buffer.speech_started" });

		const cancels = socket.sentOfType("response.cancel");

		expect(cancels).toHaveLength(1);
		expect(cancels[0]?.response_id).toBe("resp_1");

		// The part that was said is stored once, as a final line.
		const finals = recorded.transcripts.filter((entry) => entry.role === "agent" && entry.isFinal);

		expect(finals).toEqual([
			{ role: "agent", content: "Murojaatingizni ro'yxatga", isFinal: true },
		]);

		// And the `.done` that arrives after the cancel does not store it again.
		socket.emit({
			type: "response.output_audio_transcript.done",
			response_id: "resp_1",
			transcript: "Murojaatingizni ro'yxatga olaman",
		});

		expect(
			recorded.transcripts.filter((entry) => entry.role === "agent" && entry.isFinal)
		).toHaveLength(1);
	});
});

describe("tool calls", () => {
	test("a slow silent tool call is covered by a spoken holding line", async () => {
		let release = (): void => undefined;
		const pending = new Promise<void>((resolve) => {
			release = () => {
				resolve();
			};
		});

		const { socket, recorded } = await startProvider({
			toolAcknowledgementDelayMs: 10,
			toolHandler: async () => {
				await pending;
				return { ok: true, created: true };
			},
		});

		// A tool call with no speech in the turn: the caller hears nothing.
		socket.emit({ type: "response.created", response: { id: "resp_1" } });
		socket.emit({
			type: "response.function_call_arguments.done",
			response_id: "resp_1",
			call_id: "call_1",
			name: "create_ticket",
			arguments: JSON.stringify({
				subject: "Suv quvuri yorilgan",
				description: "Yunusobod 12-uy",
				category: "Suv",
				priority: "high",
			}),
		});
		socket.emit({ type: "response.done", response: { id: "resp_1", status: "completed" } });

		await Bun.sleep(40);

		const spoken = socket
			.sentOfType("conversation.item.create")
			.map((event) => JSON.stringify(event));
		const holding = spoken.filter((event) => event.includes("Bir daqiqa"));

		expect(holding).toHaveLength(1);
		expect(recorded.toolCalls).toHaveLength(1);

		release();
		await Bun.sleep(10);

		// The result still goes back, and only one response is asked for at a time.
		const outputs = socket
			.sentOfType("conversation.item.create")
			.filter((event) => JSON.stringify(event).includes("function_call_output"));

		expect(outputs).toHaveLength(1);
	});

	test("a tool call the model spoke before is not covered again", async () => {
		const { socket } = await startProvider({
			toolAcknowledgementDelayMs: 10,
			toolHandler: async () => {
				await Bun.sleep(30);
				return { ok: true };
			},
		});

		socket.emit({ type: "response.created", response: { id: "resp_1" } });

		// The model said its line first, so the turn produced audio.
		const ulaw = muLawEncode(Buffer.alloc(1_600));

		socket.emit({
			type: "response.output_audio.delta",
			response_id: "resp_1",
			delta: ulaw.toString("base64"),
		});
		socket.emit({
			type: "response.function_call_arguments.done",
			response_id: "resp_1",
			call_id: "call_1",
			name: "save_contact_details",
			arguments: JSON.stringify({ tuman: "Yunusobod" }),
		});
		socket.emit({ type: "response.done", response: { id: "resp_1", status: "completed" } });

		await Bun.sleep(60);

		const holding = socket
			.sentOfType("conversation.item.create")
			.filter((event) => JSON.stringify(event).includes("Bir daqiqa"));

		expect(holding).toHaveLength(0);
	});

	test("a fast tool never causes a holding line", async () => {
		const { socket } = await startProvider({ toolAcknowledgementDelayMs: 400 });

		socket.emit({ type: "response.created", response: { id: "resp_1" } });
		socket.emit({
			type: "response.function_call_arguments.done",
			response_id: "resp_1",
			call_id: "call_1",
			name: "add_note",
			arguments: JSON.stringify({ content: "Chaqiruvchi keksa" }),
		});
		socket.emit({ type: "response.done", response: { id: "resp_1", status: "completed" } });

		await Bun.sleep(30);

		const holding = socket
			.sentOfType("conversation.item.create")
			.filter((event) => JSON.stringify(event).includes("Bir daqiqa"));

		expect(holding).toHaveLength(0);
	});

	test("the tool result reaches the model wrapped, never as raw error text", async () => {
		const { socket } = await startProvider({
			toolHandler: async () =>
				await Promise.resolve({ ok: false, error: "expected string\n  at subject" }),
		});

		socket.emit({ type: "response.created", response: { id: "resp_1" } });
		socket.emit({
			type: "response.function_call_arguments.done",
			response_id: "resp_1",
			call_id: "call_1",
			name: "create_ticket",
			arguments: "{}",
		});
		socket.emit({ type: "response.done", response: { id: "resp_1", status: "completed" } });

		await Bun.sleep(10);

		const output = socket
			.sentOfType("conversation.item.create")
			.map((event) => event.item as { type?: string; output?: string })
			.find((item) => item.type === "function_call_output");

		expect(output).toBeDefined();

		const payload = JSON.parse(output?.output ?? "{}") as Record<string, unknown>;

		expect(payload.ok).toBe(false);
		expect(payload.error).toBe("expected string at subject");
		expect(String(payload.guidance)).toContain("Do not read this text aloud");
	});
});

describe("responses are never asked for two at a time", () => {
	test("a line requested during a running response waits for it to finish", async () => {
		const { provider, socket } = await startProvider({});

		socket.emit({ type: "response.created", response: { id: "resp_1" } });

		provider.say("Sizni operatorga ulayman.");

		// The item is added immediately, but no second response.create goes out.
		expect(socket.sentOfType("conversation.item.create")).toHaveLength(1);
		expect(socket.sentOfType("response.create")).toHaveLength(0);

		socket.emit({ type: "response.done", response: { id: "resp_1", status: "completed" } });

		expect(socket.sentOfType("response.create")).toHaveLength(1);
	});

	test("a line said before the session is ready is spoken once it is", async () => {
		const { provider, socket } = await startProvider({ ready: false });

		provider.say("Assalomu alaykum!");

		expect(socket.sentOfType("conversation.item.create")).toHaveLength(0);

		socket.emit({ type: "session.updated", session: { id: "sess_1" } });
		await Promise.resolve();
		await Promise.resolve();

		const items = socket.sentOfType("conversation.item.create");

		expect(items).toHaveLength(1);
		expect(JSON.stringify(items[0])).toContain("Assalomu alaykum!");
	});
});

/**
 * The safety net around semantic turn detection.
 *
 * Semantic detection splits one event into two: the interrupt is acoustic and
 * instant, the replacement turn is semantic and may never come. Everything here
 * guards a way the caller could otherwise be left listening to nothing.
 */
describe("semantic turn detection safety", () => {
	test("raw speech is reported even when it is not a barge-in", async () => {
		const { socket, recorded } = await startProvider({});

		// No agent turn is running, so this is not an interruption - but the caller
		// IS talking, and the silence-hangup guard has no other way to know.
		socket.emit({ type: "input_audio_buffer.speech_started" });

		expect(recorded.callerSpeech).toBe(1);
		expect(recorded.interruptions).toBe(0);
	});

	test("a barge-in that produces no new turn does not leave the line dead", async () => {
		const { socket, recorded } = await startProvider({});

		socket.emit({ type: "response.created", response: { id: "resp_1" } });
		socket.emit({ type: "input_audio_buffer.speech_started" });

		expect(recorded.interruptions).toBe(1);

		// A cough: speech stops, and the semantic classifier never rules it a turn.
		socket.emit({ type: "input_audio_buffer.speech_stopped" });
		socket.emit({ type: "response.done", response: { id: "resp_1", status: "cancelled" } });

		await Bun.sleep(2_400);

		// Without recovery the caller waits until the 20 s silence timer ends the call.
		expect(socket.sentOfType("response.create").length).toBeGreaterThan(0);
	});

	test("the closing line cannot be cancelled by caller noise", async () => {
		const { provider, socket, recorded } = await startProvider({});

		provider.suppressBargeIn?.();

		socket.emit({ type: "response.created", response: { id: "resp_bye" } });
		socket.emit({ type: "input_audio_buffer.speech_started" });

		// The goodbye is the one response the platform waits to drain; abandoning it
		// leaves waitForAgentAudioToFinish draining a sentence that stopped mid-word.
		expect(recorded.interruptions).toBe(0);
		expect(socket.sentOfType("response.cancel")).toHaveLength(0);
		// Still reported as speech, so the guard timers stay honest.
		expect(recorded.callerSpeech).toBe(1);
	});
});

describe("usage accounting", () => {
	test("the cached and audio split is read, not just the totals", async () => {
		const { socket, recorded } = await startProvider({});

		socket.emit({
			type: "response.done",
			response: {
				id: "resp_u",
				status: "completed",
				usage: {
					input_tokens: 5_000,
					output_tokens: 400,
					input_token_details: { cached_tokens: 4_200, audio_tokens: 300, text_tokens: 500 },
					output_token_details: { audio_tokens: 350, text_tokens: 50 },
				},
			},
		});

		expect(recorded.usage).toHaveLength(1);

		const usage = recorded.usage[0];

		// Without the split, a prompt total dominated by cheap cached tokens is
		// indistinguishable from one that is being charged in full every turn.
		expect(usage.promptTokens).toBe(5_000);
		expect(usage.cachedTokens).toBe(4_200);
		expect(usage.inputAudioTokens).toBe(300);
		expect(usage.completionTokens).toBe(400);
		expect(usage.outputAudioTokens).toBe(350);
	});

	test("a cancelled response reports usage with no output", async () => {
		const { socket, recorded } = await startProvider({});

		socket.emit({
			type: "response.done",
			response: {
				id: "resp_cancelled",
				status: "cancelled",
				usage: { input_tokens: 4_800, output_tokens: 0 },
			},
		});

		// The orchestrator counts a turn only when output_tokens > 0. This is the
		// event that made a barge-in look like a billed turn and skewed the per-turn
		// figures the whole tuning exercise was judged on.
		expect(recorded.usage[0]?.completionTokens).toBe(0);
	});
});
