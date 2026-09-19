import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import net from "node:net";

import {
	AUDIOSOCKET_FRAME_BYTES,
	AUDIOSOCKET_FRAME_MS,
	AUDIOSOCKET_HEADER_BYTES,
	AUDIOSOCKET_SAMPLE_RATE,
	AudioSocketPacketType,
	AudioSocketServer,
	type AudioSocketServerEvents,
	type AudioSocketSession,
	CALLER_VOICE_FLOOR_RMS,
	CALLER_VOICE_GAP_FRAMES,
	CALLER_VOICE_OVER_NOISE,
	CALLER_VOICE_RUN_FRAMES,
	CallerVoiceActivity,
	encodeAudioSocketPacket,
	formatAudioSocketUuid,
	slinRms,
} from "./audiosocket";

// ===========================================
// Fixtures
// ===========================================

const CALL_ID_HEX = "4b1d5a2e9c7f4d3a8b6e0f1a2c3d4e5f";
const CALL_ID = "4b1d5a2e-9c7f-4d3a-8b6e-0f1a2c3d4e5f";
const CALL_ID_BYTES = Buffer.from(CALL_ID_HEX, "hex");

const SECOND_CALL_ID_HEX = "00112233445566778899aabbccddeeff";
const SECOND_CALL_ID = "00112233-4455-6677-8899-aabbccddeeff";

let server: AudioSocketServer;
let clients: net.Socket[] = [];

function uuidPacket(hex = CALL_ID_HEX): Buffer {
	return encodeAudioSocketPacket(AudioSocketPacketType.UUID, Buffer.from(hex, "hex"));
}

/** slin frame whose bytes are recognisable, so payload mix-ups are visible. */
function audioPayload(fill: number, length = AUDIOSOCKET_FRAME_BYTES): Buffer {
	return Buffer.alloc(length, fill);
}

/** Deterministic PRNG (mulberry32) so a segmentation failure is reproducible. */
function createRandom(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function rampBuffer(length: number): Buffer {
	const out = Buffer.allocUnsafe(length);

	for (let i = 0; i < length; i++) {
		out[i] = i % 251;
	}

	return out;
}

interface ParsedFrame {
	type: number;
	payload: Buffer;
}

/** Independent re-implementation of the framer, used to read the server's output. */
function parseFrames(buffer: Buffer): { frames: ParsedFrame[]; leftover: number } {
	const frames: ParsedFrame[] = [];
	let offset = 0;

	while (buffer.length - offset >= AUDIOSOCKET_HEADER_BYTES) {
		const type = buffer[offset];
		const payloadLength = buffer.readUInt16BE(offset + 1);
		const end = offset + AUDIOSOCKET_HEADER_BYTES + payloadLength;

		if (end > buffer.length) {
			break;
		}

		frames.push({
			type,
			payload: Buffer.from(buffer.subarray(offset + AUDIOSOCKET_HEADER_BYTES, end)),
		});
		offset = end;
	}

	return { frames, leftover: buffer.length - offset };
}

/**
 * Frames carrying real model audio, i.e. excluding the idle silence filler.
 *
 * The pacer streams continuously - silence when the model has nothing queued - so
 * a raw frame count grows with wall-clock time. Tests assert on model audio.
 */
function modelAudioFrames(buffer: Buffer): ParsedFrame[] {
	return parseFrames(buffer).frames.filter(
		(frame) => frame.type === AudioSocketPacketType.AUDIO && !frame.payload.every((b) => b === 0)
	);
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await Bun.sleep(2);
	}

	throw new Error(`timed out waiting for ${label}`);
}

function nextEvent<K extends keyof AudioSocketServerEvents>(
	event: K,
	timeoutMs = 3000
): Promise<AudioSocketServerEvents[K]> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`timed out waiting for '${event}'`));
		}, timeoutMs);

		const unsubscribe = server.on(event, (...args: AudioSocketServerEvents[K]) => {
			clearTimeout(timer);
			unsubscribe();
			resolve(args);
		});
	});
}

async function connect(): Promise<net.Socket> {
	const port = server.boundPort;

	if (port === null) {
		throw new Error("server is not listening");
	}

	const socket = net.connect({ host: "127.0.0.1", port });
	clients.push(socket);
	socket.setNoDelay(true);

	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => {
			resolve();
		});
		socket.once("error", reject);
	});

	return socket;
}

/** Open a connection and complete the UUID handshake. */
async function openSession(hex = CALL_ID_HEX): Promise<{
	socket: net.Socket;
	session: AudioSocketSession;
}> {
	const socket = await connect();
	const pending = nextEvent("session");

	socket.write(uuidPacket(hex));

	const [session] = await pending;

	return { socket, session };
}

/** Buffer everything the server writes back to this client. */
function recordInbound(socket: net.Socket): { bytes: () => Buffer } {
	const chunks: Buffer[] = [];

	socket.on("data", (chunk: Buffer) => {
		chunks.push(chunk);
	});

	return { bytes: () => Buffer.concat(chunks) };
}

beforeEach(async () => {
	// Port 0 = ephemeral, so tests never collide with the real 9092 listener.
	server = new AudioSocketServer({ host: "127.0.0.1", port: 0, logger: null });
	await server.start();
});

afterEach(async () => {
	for (const client of clients) {
		client.destroy();
	}
	clients = [];
	await server.stop();
});

// ===========================================
// Framing over a real TCP connection
// ===========================================

describe("AudioSocketServer framing", () => {
	test("binds an ephemeral port and reports it", () => {
		expect(server.isListening).toBe(true);
		expect(server.boundPort).toBeGreaterThan(0);
		expect(server.address()?.host).toBe("127.0.0.1");
	});

	test("a UUID packet written one byte at a time still yields the right uuid", async () => {
		const socket = await connect();
		const pending = nextEvent("session");
		const packet = uuidPacket();

		expect(packet.length).toBe(AUDIOSOCKET_HEADER_BYTES + 16);

		// 19 separate writes: header byte, header byte, header byte, then 16 more.
		// Every one of them is its own TCP segment on loopback with Nagle off.
		for (const byte of packet) {
			socket.write(Buffer.from([byte]));
			await Bun.sleep(1);
		}

		const [session] = await pending;

		expect(session.uuid).toBe(CALL_ID);
		expect(session.isClosed).toBe(false);
		expect(server.sessionCount).toBe(1);
		expect(server.getSession(CALL_ID)).toBe(session);
	});

	test("two audio packets arriving in one write are both delivered", async () => {
		const { socket, session } = await openSession();

		const received: Buffer[] = [];
		server.on("audio", (audioSession, chunk) => {
			expect(audioSession.uuid).toBe(CALL_ID);
			received.push(chunk);
		});

		const first = audioPayload(0x11);
		const second = audioPayload(0x22);

		// One write, two complete packets: the parser must loop, not return after
		// the first packet and leave the second stuck in the buffer.
		socket.write(
			Buffer.concat([
				encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, first),
				encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, second),
			])
		);

		await waitUntil(() => received.length === 2, "two audio packets");

		expect(received[0].equals(first)).toBe(true);
		expect(received[1].equals(second)).toBe(true);
		expect(session.stats().bytesReceived).toBe(AUDIOSOCKET_FRAME_BYTES * 2);
	});

	test("a 3-byte header split across two writes is reassembled", async () => {
		const { socket, session } = await openSession();

		const received: Buffer[] = [];
		session.onAudio((chunk) => {
			received.push(chunk);
		});

		const payload = audioPayload(0x33);
		const packet = encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, payload);

		// Split inside the header: type + high length byte, then low length byte and
		// the payload. A parser that assumes a whole header per read breaks here.
		socket.write(packet.subarray(0, 2));
		await Bun.sleep(5);
		socket.write(packet.subarray(2));

		await waitUntil(() => received.length === 1, "header-split audio packet");
		expect(received[0].equals(payload)).toBe(true);
	});

	test("a payload split mid-way and a following packet in the same write both survive", async () => {
		const { socket, session } = await openSession();

		const received: Buffer[] = [];
		session.onAudio((chunk) => {
			received.push(chunk);
		});

		const first = audioPayload(0x44);
		const second = audioPayload(0x55);
		const firstPacket = encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, first);
		const secondPacket = encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, second);

		// Write 100 bytes of packet one, then the rest of packet one *plus* all of
		// packet two in a single write - the worst realistic segmentation.
		socket.write(firstPacket.subarray(0, 100));
		await Bun.sleep(5);
		socket.write(Buffer.concat([firstPacket.subarray(100), secondPacket]));

		await waitUntil(() => received.length === 2, "split + coalesced packets");

		expect(received[0].equals(first)).toBe(true);
		expect(received[1].equals(second)).toBe(true);
	});

	test("an unknown packet type is skipped without desynchronising the stream", async () => {
		const { socket, session } = await openSession();

		const received: Buffer[] = [];
		session.onAudio((chunk) => {
			received.push(chunk);
		});

		const payload = audioPayload(0x66);

		socket.write(
			Buffer.concat([
				// 0x7a does not exist today; the length prefix still says how to skip it.
				encodeAudioSocketPacket(0x7a, Buffer.from([1, 2, 3, 4, 5])),
				encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, payload),
			])
		);

		await waitUntil(() => received.length === 1, "audio after unknown packet type");
		expect(received[0].equals(payload)).toBe(true);
	});

	test("an error packet surfaces as a typed protocol error", async () => {
		const { socket } = await openSession();
		const pending = nextEvent("error");

		socket.write(encodeAudioSocketPacket(AudioSocketPacketType.ERROR, Buffer.from([0x01])));

		const [error, errorSession] = await pending;

		expect(error.kind).toBe("protocol");
		expect(error.code).toBe(0x01);
		expect(error.message).toContain("hangup");
		expect(errorSession?.uuid).toBe(CALL_ID);
	});

	test("a terminate packet ends the session exactly once", async () => {
		const { socket, session } = await openSession();

		let endCount = 0;
		session.onEnd(() => {
			endCount++;
		});

		const pending = nextEvent("end");
		socket.write(encodeAudioSocketPacket(AudioSocketPacketType.TERMINATE));

		const [ended] = await pending;

		expect(ended.uuid).toBe(CALL_ID);
		expect(session.isClosed).toBe(true);
		expect(server.getSession(CALL_ID)).toBeNull();

		await Bun.sleep(20);
		expect(endCount).toBe(1);
	});

	test("audio from two concurrent sessions is not cross-wired", async () => {
		const first = await openSession(CALL_ID_HEX);
		const second = await openSession(SECOND_CALL_ID_HEX);

		expect(server.sessionCount).toBe(2);
		expect(second.session.uuid).toBe(SECOND_CALL_ID);

		const byUuid = new Map<string, number[]>([
			[CALL_ID, []],
			[SECOND_CALL_ID, []],
		]);

		server.on("audio", (session, chunk) => {
			byUuid.get(session.uuid)?.push(chunk[0]);
		});

		first.socket.write(encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, audioPayload(0xa1)));
		second.socket.write(encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, audioPayload(0xb2)));

		await waitUntil(
			() =>
				(byUuid.get(CALL_ID)?.length ?? 0) === 1 && (byUuid.get(SECOND_CALL_ID)?.length ?? 0) === 1,
			"one audio packet per session"
		);

		expect(byUuid.get(CALL_ID)).toEqual([0xa1]);
		expect(byUuid.get(SECOND_CALL_ID)).toEqual([0xb2]);
	});

	test("arbitrary segmentation delivers every packet intact and in order", async () => {
		const socket = await connect();
		const pending = nextEvent("session");
		const random = createRandom(0xc0ffee);

		// A UUID packet followed by 40 audio packets of assorted lengths, all as one
		// byte stream that will be cut at random offsets.
		const packets: Buffer[] = [uuidPacket()];
		const expected: Buffer[] = [];

		for (let i = 0; i < 40; i++) {
			const length = 1 + Math.floor(random() * AUDIOSOCKET_FRAME_BYTES * 2);
			const payload = Buffer.alloc(length, i + 1);

			expected.push(payload);
			packets.push(encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, payload));
		}

		const stream = Buffer.concat(packets);
		const received: Buffer[] = [];

		server.on("audio", (_session, chunk) => {
			received.push(chunk);
		});

		let offset = 0;
		while (offset < stream.length) {
			const size = 1 + Math.floor(random() * 700);

			socket.write(stream.subarray(offset, Math.min(offset + size, stream.length)));
			offset += size;
			await Bun.sleep(1);
		}

		await pending;
		await waitUntil(() => received.length === expected.length, `${expected.length} audio packets`);

		for (let i = 0; i < expected.length; i++) {
			expect(received[i].length).toBe(expected[i].length);
			expect(received[i].equals(expected[i])).toBe(true);
		}
	});
});

// ===========================================
// Outbound audio
// ===========================================

describe("AudioSocketServer playback", () => {
	test("outbound audio is written as type 0x10 frames with 320-byte payloads", async () => {
		const { socket, session } = await openSession();
		const inbound = recordInbound(socket);

		// Three whole frames plus a 100-byte remainder.
		const audio = rampBuffer(AUDIOSOCKET_FRAME_BYTES * 3 + 100);

		session.send(audio);

		await waitUntil(() => modelAudioFrames(inbound.bytes()).length >= 3, "three outbound frames");

		const frames = modelAudioFrames(inbound.bytes());
		const { leftover } = parseFrames(inbound.bytes());

		expect(frames.length).toBe(3);
		// No partial frame on the wire: every write is a complete packet.
		expect(leftover).toBe(0);

		for (const frame of frames) {
			expect(frame.type).toBe(AudioSocketPacketType.AUDIO);
			expect(frame.payload.length).toBe(AUDIOSOCKET_FRAME_BYTES);
		}

		// Payload order and content must match the input byte for byte.
		const reassembled = Buffer.concat(frames.map((frame) => frame.payload));
		expect(reassembled.equals(audio.subarray(0, AUDIOSOCKET_FRAME_BYTES * 3))).toBe(true);

		// Only whole frames of model audio leave; the 100-byte remainder waits.
		expect(frames.length).toBe(3);

		// The 100-byte remainder is held back rather than padded, so the next chunk
		// of audio continues seamlessly.
		expect(session.stats().framesSent).toBe(3);
		expect(session.stats().framesQueued).toBe(0);

		session.send(rampBuffer(AUDIOSOCKET_FRAME_BYTES - 100));
		await waitUntil(() => modelAudioFrames(inbound.bytes()).length === 4, "fourth frame");

		const fourth = modelAudioFrames(inbound.bytes())[3];
		expect(fourth.payload.length).toBe(AUDIOSOCKET_FRAME_BYTES);
		// First 100 bytes of frame four are the remainder of the first send().
		expect(
			fourth.payload.subarray(0, 100).equals(audio.subarray(AUDIOSOCKET_FRAME_BYTES * 3))
		).toBe(true);
	});

	test("flush() pads a partial frame with silence", async () => {
		const { socket, session } = await openSession();
		const inbound = recordInbound(socket);

		session.send(Buffer.alloc(64, 0x7f));
		// A partial frame is held back, so no model audio has left yet (idle silence
		// may already be streaming, which is why this filters for model audio).
		expect(modelAudioFrames(inbound.bytes()).length).toBe(0);

		session.flush();

		await waitUntil(() => modelAudioFrames(inbound.bytes()).length === 1, "flushed frame");

		const frame = modelAudioFrames(inbound.bytes())[0];

		expect(frame.payload.length).toBe(AUDIOSOCKET_FRAME_BYTES);
		expect(frame.payload.subarray(0, 64).equals(Buffer.alloc(64, 0x7f))).toBe(true);
		// Padding is digital silence, not leftover memory.
		expect(frame.payload.subarray(64).equals(Buffer.alloc(AUDIOSOCKET_FRAME_BYTES - 64))).toBe(
			true
		);
	});

	test("streams on its own clock at ~20 ms per frame, never bursting", async () => {
		const { socket, session } = await openSession();
		const inbound = recordInbound(socket);

		// Deliberately no inbound audio. Asterisk expects a continuous outbound
		// stream and will deliver nothing past the UUID packet if the server waits
		// for it first - measured on a real call as packetsReceived=1,
		// bytesReceived=0 with every model frame dropped.
		const frameCount = 10;
		const startedAt = Date.now();

		session.send(rampBuffer(AUDIOSOCKET_FRAME_BYTES * frameCount));

		await waitUntil(
			() => modelAudioFrames(inbound.bytes()).length >= frameCount,
			`${frameCount} paced frames`,
			5000
		);

		const elapsed = Date.now() - startedAt;

		// 10 frames is 200 ms of audio. Even allowing 25% slack for timer
		// granularity, they must not arrive faster than 150 ms: anything quicker
		// means catch-up bursting, which is precisely what made a live call
		// inaudible while its recording stayed perfect (26% of RTP packets left
		// under 5 ms apart, gaps up to 52 ms).
		expect(elapsed).toBeGreaterThanOrEqual(frameCount * AUDIOSOCKET_FRAME_MS * 0.75);
		expect(session.stats().framesSent).toBeGreaterThanOrEqual(frameCount);
	});

	test("sends silence while the model is idle so the stream has no holes", async () => {
		const { socket, session } = await openSession();
		const inbound = recordInbound(socket);

		// Nothing queued and nothing inbound: the pacer still emits, keeping the far
		// end's jitter buffer primed and the NAT binding alive.
		await waitUntil(
			() => parseFrames(inbound.bytes()).frames.length >= 3,
			"idle silence frames",
			5000
		);

		const { frames, leftover } = parseFrames(inbound.bytes());
		expect(leftover).toBe(0);

		for (const frame of frames) {
			expect(frame.type).toBe(AudioSocketPacketType.AUDIO);
			expect(frame.payload.length).toBe(AUDIOSOCKET_FRAME_BYTES);
			expect(frame.payload.every((byte) => byte === 0)).toBe(true);
		}

		// Filler is not delivered model audio and must not be counted as such.
		expect(session.stats().framesSent).toBe(0);
	});

	test("waitForQueueDrain resolves only once the queued audio has been written", async () => {
		const { socket, session } = await openSession();
		const inbound = recordInbound(socket);

		const frameCount = 8;
		session.send(rampBuffer(AUDIOSOCKET_FRAME_BYTES * frameCount));
		expect(session.queuedFrames()).toBeGreaterThan(0);

		const startedAt = Date.now();
		const drained = await session.waitForQueueDrain(5000);
		const elapsed = Date.now() - startedAt;

		expect(drained).toBe(true);
		expect(session.queuedFrames()).toBe(0);

		// Drain means "handed to the socket", so the far end observes the last frame a
		// round trip later. That is exactly why the caller also allows for Asterisk's
		// own playout buffer before cutting the channel.
		await waitUntil(
			() => modelAudioFrames(inbound.bytes()).length === frameCount,
			`all ${frameCount} frames observed`
		);

		// This is the guarantee the caller depends on before hanging up: the wait
		// lasts as long as the audio does, rather than returning immediately and
		// letting the channel be cut mid-word.
		expect(elapsed).toBeGreaterThanOrEqual(frameCount * AUDIOSOCKET_FRAME_MS * 0.5);
	});

	test("waitForQueueDrain reports failure when the session closes with audio queued", async () => {
		const { session } = await openSession();

		session.send(rampBuffer(AUDIOSOCKET_FRAME_BYTES * 50));

		const pending = session.waitForQueueDrain(5000);
		session.hangup();

		// Resolves at once rather than sitting until the timeout, and says the audio
		// did not make it - which is what marks a truncated farewell.
		expect(await pending).toBe(false);
		expect(session.stats().framesAbandoned).toBeGreaterThan(0);
	});

	test("barge-in releases a pending drain wait", async () => {
		const { session } = await openSession();

		session.send(rampBuffer(AUDIOSOCKET_FRAME_BYTES * 50));

		const pending = session.waitForQueueDrain(5000);
		expect(session.discardQueuedAudio()).toBeGreaterThan(0);

		expect(await pending).toBe(false);
		// Barge-in is deliberate, so it is not counted as audio lost at close.
		expect(session.stats().framesAbandoned).toBe(0);
	});

	test("an already drained queue resolves without waiting", async () => {
		const { session } = await openSession();

		expect(session.queuedFrames()).toBe(0);
		expect(await session.waitForQueueDrain(5000)).toBe(true);
	});

	test("the outbound backlog is bounded and drops the oldest frames", async () => {
		await server.stop();
		server = new AudioSocketServer({
			host: "127.0.0.1",
			port: 0,
			logger: null,
			maxQueuedFrames: 2,
		});
		await server.start();

		const { socket, session } = await openSession();
		const inbound = recordInbound(socket);

		// 10 frames of audio at once, but only 2 may be held.
		const frameCount = 10;
		const audio = Buffer.allocUnsafe(AUDIOSOCKET_FRAME_BYTES * frameCount);
		for (let i = 0; i < frameCount; i++) {
			audio.fill(0xc0 + i, i * AUDIOSOCKET_FRAME_BYTES, (i + 1) * AUDIOSOCKET_FRAME_BYTES);
		}

		session.send(audio);

		const stats = session.stats();
		expect(stats.framesDropped).toBe(frameCount - 2);

		await waitUntil(() => modelAudioFrames(inbound.bytes()).length === 2, "two surviving frames");

		const frames = modelAudioFrames(inbound.bytes());

		// The survivors are the two newest, proving the oldest were dropped.
		expect(frames[0].payload[0]).toBe(0xc0 + 8);
		expect(frames[1].payload[0]).toBe(0xc0 + 9);
	});

	test("hangup() sends a terminate packet and closes the connection", async () => {
		const { socket, session } = await openSession();
		const inbound = recordInbound(socket);

		const closed = new Promise<void>((resolve) => {
			socket.once("close", () => {
				resolve();
			});
		});

		session.hangup();
		await closed;

		const { frames } = parseFrames(inbound.bytes());

		expect(frames.length).toBe(1);
		expect(frames[0].type).toBe(AudioSocketPacketType.TERMINATE);
		expect(frames[0].payload.length).toBe(0);
		expect(session.isClosed).toBe(true);

		// Sending after a hangup is a no-op, not a crash.
		session.send(audioPayload(0x01));
		expect(session.stats().framesQueued).toBe(0);
	});

	test("stop() closes live sessions", async () => {
		const { session } = await openSession();
		const ended = nextEvent("end");

		await server.stop();
		const [endedSession] = await ended;

		expect(endedSession.uuid).toBe(CALL_ID);
		expect(session.isClosed).toBe(true);
		expect(server.isListening).toBe(false);
	});
});

// ===========================================
// Pure helpers
// ===========================================

describe("AudioSocket helpers", () => {
	test("formatAudioSocketUuid produces a canonical dashed uuid", () => {
		expect(formatAudioSocketUuid(CALL_ID_BYTES)).toBe(CALL_ID);
		expect(formatAudioSocketUuid(Buffer.alloc(16))).toBe("00000000-0000-0000-0000-000000000000");
		expect(formatAudioSocketUuid(Buffer.alloc(16, 0xff))).toBe(
			"ffffffff-ffff-ffff-ffff-ffffffffffff"
		);
	});

	test("encodeAudioSocketPacket writes a big-endian length", () => {
		const packet = encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, audioPayload(0x01));

		expect(packet[0]).toBe(0x10);
		// 320 = 0x0140, big-endian.
		expect(packet[1]).toBe(0x01);
		expect(packet[2]).toBe(0x40);
		expect(packet.length).toBe(AUDIOSOCKET_HEADER_BYTES + AUDIOSOCKET_FRAME_BYTES);

		const empty = encodeAudioSocketPacket(AudioSocketPacketType.TERMINATE);
		expect(Array.from(empty)).toEqual([0x00, 0x00, 0x00]);
	});
});

// ===========================================
// Caller voice activity
// ===========================================

/**
 * One 20 ms slin frame at a chosen RMS.
 *
 * A square wave, so every sample sits at the target level and the frame's RMS is
 * exactly `rms` - what these tests are about is the threshold, not the waveform.
 */
function frameAtRms(rms: number): Buffer {
	const frame = Buffer.alloc(AUDIOSOCKET_FRAME_BYTES);
	const samples = AUDIOSOCKET_FRAME_BYTES / 2;

	for (let i = 0; i < samples; i++) {
		frame.writeInt16LE(i % 2 === 0 ? rms : -rms, i * 2);
	}

	return frame;
}

/** -14 dBFS: the level a talking caller measured at on real call 6c5a2006. */
const LOUD = frameAtRms(6500);
/** -64 dBFS: the level that call's line noise measured at between words. */
const QUIET = frameAtRms(20);
/** -60 dBFS: comfort noise on a healthy line, and what seeds the noise estimate. */
const LINE = frameAtRms(33);
/**
 * -38 dBFS: call edd90885, 150 s of band-limited noise with no speech in it. This
 * is the level that made a fixed -45 dBFS gate report a permanently talking
 * caller and defer the guard six times on a line nobody was on.
 */
const NOISY_LINE = frameAtRms(413);
/** -30 dBFS: a worse line still, and still nobody on it. */
const VERY_NOISY_LINE = frameAtRms(1036);
const DIGITAL_ZERO = Buffer.alloc(AUDIOSOCKET_FRAME_BYTES);

/**
 * How much line the detector is given before anybody speaks.
 *
 * Half a second, which is what a real call gives it: the channel is answered and
 * the greeting plays before the caller says a word. The estimate is seeded from
 * the first frame, so a test that opened on speech would be testing the one case
 * "a caller already talking when the socket attaches" covers deliberately.
 */
const LEAD_IN_FRAMES = 25;

/** Push `frames` frames, advancing a fake clock 20 ms each time. Returns the new clock. */
function pushFrames(
	detector: CallerVoiceActivity,
	frame: Buffer,
	frames: number,
	startAt: number
): number {
	let now = startAt;

	for (let i = 0; i < frames; i++) {
		detector.push(frame, now);
		now += AUDIOSOCKET_FRAME_MS;
	}

	return now;
}

/** A detector that has heard half a second of quiet line, as every real call gives it. */
function detectorOnALine(line: Buffer = LINE): { detector: CallerVoiceActivity; now: number } {
	const detector = new CallerVoiceActivity();
	const now = pushFrames(detector, line, LEAD_IN_FRAMES, 1_000_000);

	return { detector, now };
}

describe("slinRms", () => {
	test("measures a known level exactly", () => {
		expect(slinRms(frameAtRms(6500))).toBeCloseTo(6500, 6);
		expect(slinRms(frameAtRms(104))).toBeCloseTo(104, 6);
		expect(slinRms(DIGITAL_ZERO)).toBe(0);
	});

	test("is safe on empty and odd-length buffers", () => {
		expect(slinRms(Buffer.alloc(0))).toBe(0);
		// A stray odd byte cannot reach here off the wire, but it must not throw
		// inside an audio callback if it ever does.
		expect(slinRms(Buffer.from([0x00]))).toBe(0);
		expect(slinRms(Buffer.from([0x10, 0x27, 0x7f]))).toBeCloseTo(10_000, 6);
	});

	test("the shipped gates are -50 dBFS and 8 dB over the line", () => {
		const floorDbfs = 20 * Math.log10(CALLER_VOICE_FLOOR_RMS / 32_768);
		const overNoiseDb = 20 * Math.log10(CALLER_VOICE_OVER_NOISE);

		expect(floorDbfs).toBeCloseTo(-50, 6);
		expect(overNoiseDb).toBeGreaterThan(7.9);
		expect(overNoiseDb).toBeLessThan(8.1);
	});
});

describe("CallerVoiceActivity", () => {
	test("a fresh detector has heard nothing", () => {
		const detector = new CallerVoiceActivity();

		expect(detector.msSinceVoice(1000)).toBeNull();
		expect(detector.msSinceFrame(1000)).toBeNull();
		expect(detector.spokeWithin(20_000, 1000)).toBe(false);
		expect(detector.stats().frames).toBe(0);
		expect(detector.stats().noiseFloorDbfs).toBeNull();
	});

	test("continuous digital silence is never speech, however long it runs", () => {
		const detector = new CallerVoiceActivity();
		// 30 s of frames: exactly the case the guard SHOULD still hang up on.
		const now = pushFrames(detector, DIGITAL_ZERO, 1500, 1_000_000);

		expect(detector.stats().frames).toBe(1500);
		expect(detector.stats().loudFrames).toBe(0);
		expect(detector.msSinceVoice(now)).toBeNull();
		expect(detector.spokeWithin(20_000, now)).toBe(false);
		// Frames DID arrive - which is why frame arrival cannot be the test.
		expect(detector.msSinceFrame(now)).toBe(AUDIOSOCKET_FRAME_MS);
		// ...and the clamp keeps the reported figure a number rather than -Infinity.
		expect(detector.stats().noiseFloorDbfs).toBeCloseTo(-58, 0);
	});

	test("quiet line noise is never speech", () => {
		const detector = new CallerVoiceActivity();
		const now = pushFrames(detector, QUIET, 1500, 1_000_000);

		expect(detector.stats().loudFrames).toBe(0);
		expect(detector.spokeWithin(20_000, now)).toBe(false);
	});

	test("a NOISY line with nobody on it is never speech either", () => {
		// The blocker this detector replaced: 150 s of -38 dBFS noise on call
		// edd90885 cleared a fixed -45 dBFS gate on every one of its 1398 frames, so
		// the line read as a caller who never stopped talking and the guard was
		// disarmed for the whole call. Judged against its OWN noise, it is silence.
		const detector = new CallerVoiceActivity();
		const now = pushFrames(detector, NOISY_LINE, 7_500, 1_000_000);

		expect(detector.stats().frames).toBe(7_500);
		expect(detector.stats().loudFrames).toBe(0);
		expect(detector.stats().voicedFrames).toBe(0);
		expect(detector.msSinceVoice(now)).toBeNull();
		expect(detector.stats().noiseFloorDbfs).toBeCloseTo(-38, 0);
	});

	test("an even worse line with nobody on it is still not speech", () => {
		const detector = new CallerVoiceActivity();

		pushFrames(detector, VERY_NOISY_LINE, 1_500, 1_000_000);

		expect(detector.stats().loudFrames).toBe(0);
	});

	test("a run shorter than the minimum does not count as speech", () => {
		// A keypad click or a line pop: loud, but over before a syllable could be.
		const { detector, now: from } = detectorOnALine();
		let now = pushFrames(detector, LOUD, CALLER_VOICE_RUN_FRAMES - 1, from);
		now = pushFrames(detector, DIGITAL_ZERO, 100, now);

		expect(detector.stats().loudFrames).toBe(CALLER_VOICE_RUN_FRAMES - 1);
		expect(detector.stats().voicedFrames).toBe(0);
		expect(detector.msSinceVoice(now)).toBeNull();
	});

	test("a sustained run counts as speech from the frame that completes it", () => {
		const { detector, now: from } = detectorOnALine();
		const now = pushFrames(detector, LOUD, CALLER_VOICE_RUN_FRAMES, from);

		// The run completes on the last of those frames, whose timestamp is one
		// frame behind where the clock now stands.
		expect(detector.stats().lastVoiceAt).toBe(now - AUDIOSOCKET_FRAME_MS);
		expect(detector.spokeWithin(1000, now)).toBe(true);
	});

	test("a pause inside a word does not make the caller re-earn their run", () => {
		const { detector, now: from } = detectorOnALine();
		let now = pushFrames(detector, LOUD, 20, from);

		// A stop consonant: below the gates, but shorter than the tolerated gap.
		now = pushFrames(detector, DIGITAL_ZERO, CALLER_VOICE_GAP_FRAMES - 1, now);
		// The gap itself is not speech, so the clock since the caller's last real
		// sound keeps running.
		expect(detector.msSinceVoice(now)).toBe(CALLER_VOICE_GAP_FRAMES * AUDIOSOCKET_FRAME_MS);

		// One frame is then enough to be speech again: the run survived the gap.
		now = pushFrames(detector, LOUD, 1, now);
		expect(detector.msSinceVoice(now)).toBe(AUDIOSOCKET_FRAME_MS);
	});

	test("a gap longer than the tolerance does make the caller re-earn their run", () => {
		const { detector, now: from } = detectorOnALine();
		let now = pushFrames(detector, LOUD, 20, from);
		now = pushFrames(detector, DIGITAL_ZERO, CALLER_VOICE_GAP_FRAMES, now);

		const before = detector.stats().voicedFrames;
		now = pushFrames(detector, LOUD, 1, now);

		expect(detector.stats().voicedFrames).toBe(before);
	});

	test("msSinceVoice tracks real silence once the caller stops", () => {
		const { detector, now: from } = detectorOnALine();
		let now = pushFrames(detector, LOUD, 50, from);
		now = pushFrames(detector, DIGITAL_ZERO, 1200, now);

		// 24 s of silence, plus the one frame between the last loud frame and the
		// clock at the moment it was pushed.
		expect(detector.msSinceVoice(now)).toBe(1201 * AUDIOSOCKET_FRAME_MS);
		expect(detector.spokeWithin(20_000, now)).toBe(false);
		expect(detector.spokeWithin(30_000, now)).toBe(true);
	});

	test("speech-shaped audio with natural gaps stays continuously voiced", () => {
		const { detector, now: start } = detectorOnALine();
		let now = start;

		// 30 s of "words": 400 ms of speech, 80 ms of gap, over and over. That is
		// the reported bug - a caller talking for half a minute - and at no point
		// in it may the detector claim the line went quiet. The gaps are also what
		// keeps the estimate down: it is exactly this that a tone does not have.
		for (let word = 0; word < 63; word++) {
			now = pushFrames(detector, LOUD, 20, now);
			now = pushFrames(detector, DIGITAL_ZERO, 4, now);

			expect(detector.spokeWithin(1000, now)).toBe(true);
		}

		expect(now - start).toBeGreaterThanOrEqual(30_000);
		expect(detector.spokeWithin(20_000, now)).toBe(true);
	});

	test("a caller on a bad line is still heard over it", () => {
		// -20 dBFS speech riding a -35 dBFS line: a poor mobile connection, not an
		// unusable one. The relative gate has to move with the line, not reject it.
		const line = frameAtRms(583);
		const speech = frameAtRms(3328);
		const { detector, now: start } = detectorOnALine(line);
		let now = start;

		for (let word = 0; word < 40; word++) {
			now = pushFrames(detector, speech, 15, now);
			now = pushFrames(detector, line, 5, now);
		}

		expect(detector.stats().voicedFrames).toBeGreaterThan(300);
		expect(detector.spokeWithin(1000, now)).toBe(true);
	});

	test("a tone left on the line stops counting once it becomes the line", () => {
		// A radio next to an abandoned handset. It is loud, so it starts as speech;
		// it never stops, so the estimate climbs to meet it and the call becomes
		// hangable again. Without this the max-duration limit would be the only stop.
		const { detector, now: start } = detectorOnALine();
		const now = pushFrames(detector, LOUD, 750, start);
		const lastVoiceAt = detector.stats().lastVoiceAt;

		expect(lastVoiceAt).not.toBeNull();
		// Absorbed inside ten seconds, and quiet for the rest of the fifteen.
		expect((lastVoiceAt as number) - start).toBeLessThan(10_000);
		expect(detector.spokeWithin(4_000, now)).toBe(false);
	});

	test("a caller already talking when the socket attaches is heard at their first pause", () => {
		// The estimate is seeded from the first frame, so speech arriving before any
		// line has been measured seeds it high. This is the accepted cost of not
		// starting low - starting low is what let 150 s of noise read as a caller -
		// and one gap between words undoes it.
		const detector = new CallerVoiceActivity();
		let now = pushFrames(detector, LOUD, 20, 1_000_000);

		expect(detector.stats().voicedFrames).toBe(0);

		now = pushFrames(detector, DIGITAL_ZERO, 4, now);
		now = pushFrames(detector, LOUD, CALLER_VOICE_RUN_FRAMES, now);

		expect(detector.stats().voicedFrames).toBeGreaterThan(0);
		expect(detector.spokeWithin(1000, now)).toBe(true);
	});

	test("push reports the speech it found, so the caller is measured once and acted on once", () => {
		const { detector, now: from } = detectorOnALine();

		expect(detector.push(LOUD, from)).toBe(false);
		expect(
			detector.push(Buffer.concat(Array<Buffer>(CALLER_VOICE_RUN_FRAMES).fill(LOUD)), from + 20)
		).toBe(true);
		expect(detector.push(DIGITAL_ZERO, from + 40)).toBe(false);
	});

	test("re-frames chunks of any length, so the run lengths keep their meaning", () => {
		const byFrame = new CallerVoiceActivity();
		const inOneGo = new CallerVoiceActivity();
		const now = 1_000_000;
		const lead = Buffer.concat(Array<Buffer>(LEAD_IN_FRAMES).fill(LINE));
		const run = Buffer.concat(Array<Buffer>(CALLER_VOICE_RUN_FRAMES).fill(LOUD));

		pushFrames(byFrame, LINE, LEAD_IN_FRAMES, now);
		pushFrames(byFrame, LOUD, CALLER_VOICE_RUN_FRAMES, now);
		inOneGo.push(Buffer.concat([lead, run]), now);

		expect(inOneGo.stats().frames).toBe(byFrame.stats().frames);
		expect(inOneGo.stats().voicedFrames).toBe(byFrame.stats().voicedFrames);
		expect(inOneGo.stats().voicedFrames).toBe(1);

		// And in chunks that straddle the 20 ms boundary.
		const straddling = new CallerVoiceActivity();
		const whole = Buffer.concat([lead, run]);

		for (let offset = 0; offset < whole.length; offset += 111) {
			straddling.push(whole.subarray(offset, Math.min(offset + 111, whole.length)), now);
		}

		expect(straddling.stats().frames).toBe(LEAD_IN_FRAMES + CALLER_VOICE_RUN_FRAMES);
		expect(straddling.stats().voicedFrames).toBe(1);
	});

	test("an empty chunk changes nothing", () => {
		const detector = new CallerVoiceActivity();

		expect(detector.push(Buffer.alloc(0), 1000)).toBe(false);
		expect(detector.stats().frames).toBe(0);
		expect(detector.msSinceFrame(1000)).toBeNull();
	});

	test("stats report what was measured", () => {
		const { detector, now: from } = detectorOnALine();
		const now = pushFrames(detector, LOUD, 10, from);
		const stats = detector.stats();

		expect(stats.frames).toBe(LEAD_IN_FRAMES + 10);
		expect(stats.loudFrames).toBe(10);
		expect(stats.voicedFrames).toBe(10 - CALLER_VOICE_RUN_FRAMES + 1);
		expect(stats.voicedMs).toBe(stats.voicedFrames * AUDIOSOCKET_FRAME_MS);
		expect(stats.peakRms).toBe(6500);
		expect(stats.lastFrameAt).toBe(now - AUDIOSOCKET_FRAME_MS);
		// The line under the speech, which is the other half of "was anybody there".
		expect(stats.noiseFloorDbfs).not.toBeNull();
		expect(stats.noiseFloorDbfs as number).toBeLessThan(-20);
	});

	test("the frame maths matches the AudioSocket wire", () => {
		// 8 kHz * 20 ms * 2 bytes. If this ever changes, every run length above is
		// measuring a different amount of time than its comment claims.
		expect(AUDIOSOCKET_FRAME_BYTES).toBe(
			(AUDIOSOCKET_SAMPLE_RATE / 1000) * AUDIOSOCKET_FRAME_MS * 2
		);
		expect(CALLER_VOICE_RUN_FRAMES * AUDIOSOCKET_FRAME_MS).toBe(160);
		expect(CALLER_VOICE_GAP_FRAMES * AUDIOSOCKET_FRAME_MS).toBe(120);
	});
});
