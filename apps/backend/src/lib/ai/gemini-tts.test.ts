import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import {
	GEMINI_TTS_MODEL,
	MAX_SAMPLE_CHARS,
	pcmToWav,
	sampleRateFromMime,
	voiceSampleCacheKey,
} from "./gemini-tts";

describe("the WAV wrapper", () => {
	// The browser plays a WAV blob and cannot play the headerless L16 the API
	// returns, so a wrong header is a silent player, not a warning.
	test("writes a 44-byte RIFF header describing 16-bit mono PCM", () => {
		const pcm = Buffer.alloc(960); // 20 ms at 24 kHz
		const wav = pcmToWav(pcm, 24_000);

		expect(wav.length).toBe(pcm.length + 44);
		expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
		expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
		expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
		expect(wav.readUInt16LE(20)).toBe(1); // PCM
		expect(wav.readUInt16LE(22)).toBe(1); // mono
		expect(wav.readUInt32LE(24)).toBe(24_000);
		expect(wav.readUInt32LE(28)).toBe(48_000); // byte rate
		expect(wav.readUInt16LE(32)).toBe(2); // block align
		expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
		expect(wav.toString("ascii", 36, 40)).toBe("data");
		expect(wav.readUInt32LE(40)).toBe(pcm.length);
		expect(wav.readUInt32LE(4)).toBe(pcm.length + 36);
	});

	test("keeps the samples byte for byte", () => {
		const pcm = Buffer.from([0x01, 0x02, 0xfd, 0xfe]);

		expect(pcmToWav(pcm, 8_000).subarray(44)).toEqual(pcm);
	});
});

describe("the sample rate", () => {
	test("comes from the mime type the API sends", () => {
		expect(sampleRateFromMime("audio/L16;codec=pcm;rate=24000")).toBe(24_000);
	});

	// A rate guessed wrong plays the voice at the wrong pitch, which would be read
	// as "that voice sounds like a chipmunk" rather than as a bug.
	test("falls back to the documented 24 kHz when the header says nothing usable", () => {
		expect(sampleRateFromMime(undefined)).toBe(24_000);
		expect(sampleRateFromMime("audio/L16")).toBe(24_000);
		expect(sampleRateFromMime("audio/L16;rate=abc")).toBe(24_000);
	});
});

describe("the cache key", () => {
	test("separates the voices and the lines", () => {
		expect(voiceSampleCacheKey("Sulafat", "Salom")).not.toBe(voiceSampleCacheKey("Kore", "Salom"));
		expect(voiceSampleCacheKey("Sulafat", "Salom")).not.toBe(
			voiceSampleCacheKey("Sulafat", "Salom!")
		);
	});
});

test("the model is the flash TTS one, the only one measured to return audio", () => {
	expect(GEMINI_TTS_MODEL).toBe("gemini-2.5-flash-preview-tts");
	expect(MAX_SAMPLE_CHARS).toBeGreaterThan(0);
});
