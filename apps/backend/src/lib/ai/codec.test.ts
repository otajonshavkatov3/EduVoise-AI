import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import {
	BYTES_PER_SAMPLE,
	biquadMagnitudeDb,
	clampInt16,
	createAgentVoiceChain,
	createDownsampler24kTo8k,
	createUpsampler8kTo24k,
	DOWNSAMPLE_CUTOFF_HZ,
	designPeakingBiquad,
	downsample24kTo8k,
	INT16_MAX,
	INT16_MIN,
	LIMITER_CEILING,
	LIMITER_CEILING_SAMPLE,
	LIMITER_LOOKAHEAD_SAMPLES,
	MU_LAW_SILENCE,
	muLawDecode,
	muLawDecodeSample,
	muLawEncode,
	muLawEncodeSample,
	OUTPUT_GAIN_MAX_DB,
	PRESENCE_CENTRE_HZ,
	PRESENCE_MAX_DB,
	RESAMPLE_FACTOR,
	RESAMPLE_ROUND_TRIP_DELAY_8K,
	readInt16LEArray,
	upsample8kTo24k,
	writeInt16LEArray,
} from "./codec";

// ===========================================
// Test helpers
// ===========================================

/** Largest magnitude G.711 u-law can represent (decode(0x80)). */
const MU_LAW_FULL_SCALE = 32124;

function makeSine(frequencyHz: number, sampleRate: number, sampleCount: number, amplitude: number) {
	const samples = new Int16Array(sampleCount);

	for (let i = 0; i < sampleCount; i++) {
		samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate));
	}

	return writeInt16LEArray(samples);
}

/** Mean power (energy per sample), optionally skipping a filter transient. */
function meanPower(samples: Int16Array, skip = 0): number {
	let total = 0;

	for (let i = skip; i < samples.length; i++) {
		total += samples[i] * samples[i];
	}

	return total / (samples.length - skip);
}

// ===========================================
// G.711 u-law
// ===========================================

describe("g711 u-law companding", () => {
	test("encodes the ITU-T reference anchors to the exact expected bytes", () => {
		// u-law is stored complemented, so linear silence is 0xff, not 0x00.
		expect(muLawEncodeSample(0)).toBe(0xff);
		expect(MU_LAW_SILENCE).toBe(0xff);

		// Positive full scale sits at the top of segment 7: sign bit 1 after the
		// final complement -> 0x80. Negative full scale is the same code with the
		// sign bit cleared -> 0x00.
		expect(muLawEncodeSample(MU_LAW_FULL_SCALE)).toBe(0x80);
		expect(muLawEncodeSample(-MU_LAW_FULL_SCALE)).toBe(0x00);

		// Segment 0 walks one mantissa step per 4 linear counts (the 14-bit shift):
		// +1 still lands in the first cell, +8 lands one cell higher.
		expect(muLawEncodeSample(1)).toBe(0xff);
		expect(muLawEncodeSample(8)).toBe(0xfe);

		// The reference algorithm shifts a *signed* value right by 2, which floors
		// toward -inf, so -1 has magnitude 1 (not 0) and encodes one cell away from
		// negative silence. Every G.711 implementation shares this asymmetry.
		expect(muLawEncodeSample(-1)).toBe(0x7e);
	});

	test("decodes the reference anchors and keeps the table sign-symmetric", () => {
		expect(muLawDecodeSample(0xff)).toBe(0);
		// 0x7f is "negative zero" in u-law and must also decode to silence.
		expect(muLawDecodeSample(0x7f)).toBe(0);
		expect(muLawDecodeSample(0x80)).toBe(MU_LAW_FULL_SCALE);
		expect(muLawDecodeSample(0x00)).toBe(-MU_LAW_FULL_SCALE);

		let minimum = INT16_MAX;
		let maximum = INT16_MIN;

		for (let byte = 0; byte < 256; byte++) {
			const value = muLawDecodeSample(byte);

			// Flipping the sign bit must flip the sign of the sample exactly, so a
			// code and its mirror always sum to zero.
			expect(value + muLawDecodeSample(byte ^ 0x80)).toBe(0);

			minimum = Math.min(minimum, value);
			maximum = Math.max(maximum, value);
		}

		expect(maximum).toBe(MU_LAW_FULL_SCALE);
		expect(minimum).toBe(-MU_LAW_FULL_SCALE);
	});

	test("saturates loud input instead of wrapping it", () => {
		// If the 16-bit clip were missing, 40000 would wrap to -25536 and encode to
		// a *negative* code - an inverted-polarity click in the middle of speech.
		expect(muLawEncodeSample(40_000)).toBe(muLawEncodeSample(INT16_MAX));
		expect(muLawEncodeSample(40_000)).toBe(0x80);
		expect(muLawEncodeSample(-40_000)).toBe(muLawEncodeSample(INT16_MIN));
		expect(muLawEncodeSample(-40_000)).toBe(0x00);
	});

	test("round trip error over the whole int16 range stays inside the G.711 grid", () => {
		// Worst case is bounded by half the coarsest quantisation step. Segment 7
		// reconstruction points are 1024 linear counts apart, so the bound is 512 -
		// plus up to 3 counts on the negative side from the signed >> 2 above.
		const worstCaseBound = 515;
		let worst = 0;

		for (let value = -MU_LAW_FULL_SCALE; value <= MU_LAW_FULL_SCALE; value++) {
			const error = Math.abs(value - muLawDecodeSample(muLawEncodeSample(value)));
			worst = Math.max(worst, error);
		}

		expect(worst).toBeLessThanOrEqual(worstCaseBound);
		// And it really is that coarse at the top of the range - if this dropped to
		// 0 someone replaced companding with a pass-through.
		expect(worst).toBeGreaterThan(256);
	});

	test("1 kHz sine at 8 kHz survives a u-law round trip within quantisation error", () => {
		const amplitude = 32_000;
		const original = readInt16LEArray(makeSine(1000, 8000, 8000, amplitude));
		const roundTripped = readInt16LEArray(muLawDecode(muLawEncode(writeInt16LEArray(original))));

		expect(roundTripped.length).toBe(original.length);

		let absoluteErrorSum = 0;
		let noisePower = 0;
		let signalPower = 0;

		for (let i = 0; i < original.length; i++) {
			const error = original[i] - roundTripped[i];

			absoluteErrorSum += Math.abs(error);
			noisePower += error * error;
			signalPower += original[i] * original[i];
		}

		const meanAbsoluteError = absoluteErrorSum / original.length;

		// Threshold justification: this signal lives almost entirely in u-law
		// segment 7, where reconstruction points are 1024 linear counts apart. The
		// mean absolute error of a quantiser can never exceed half a step, so 512
		// is the tight analytical bound for *any* signal at this level. Measured
		// value is ~172 because a full-scale sine only visits three magnitudes.
		expect(meanAbsoluteError).toBeLessThan(512);
		// Non-zero: encode/decode is genuinely lossy, not an accidental identity.
		expect(meanAbsoluteError).toBeGreaterThan(0);

		// G.711 is specified at roughly 38 dB SQNR for full-scale input; anything
		// below 35 dB means the segment/mantissa split is wrong.
		const snrDb = 10 * Math.log10(signalPower / noisePower);
		expect(snrDb).toBeGreaterThan(35);
	});

	test("buffer lengths follow the 2:1 companding ratio and odd bytes are ignored", () => {
		const pcm = makeSine(500, 8000, 160, 12_000);

		expect(pcm.length).toBe(160 * BYTES_PER_SAMPLE);
		expect(muLawEncode(pcm).length).toBe(160);
		expect(muLawDecode(muLawEncode(pcm)).length).toBe(160 * BYTES_PER_SAMPLE);

		// A half-delivered sample must not produce a garbage sample.
		const odd = Buffer.concat([pcm, Buffer.from([0x7f])]);
		expect(muLawEncode(odd).length).toBe(160);
		expect(muLawEncode(odd)).toEqual(muLawEncode(pcm));
	});
});

// ===========================================
// Resampling
// ===========================================

describe("8k <-> 24k resampling", () => {
	test("length relationships are exact: n -> 3n -> n", () => {
		const sampleCount = 1600;
		const original = makeSine(300, 8000, sampleCount, 8000);

		const upsampled = upsample8kTo24k(original);
		const downsampled = downsample24kTo8k(upsampled);

		expect(original.length / BYTES_PER_SAMPLE).toBe(sampleCount);
		expect(upsampled.length / BYTES_PER_SAMPLE).toBe(sampleCount * RESAMPLE_FACTOR);
		expect(downsampled.length / BYTES_PER_SAMPLE).toBe(sampleCount);
		expect(RESAMPLE_ROUND_TRIP_DELAY_8K).toBe(22);
	});

	test("300 Hz sine survives up- then down-sampling", () => {
		const amplitude = 12_000;
		const sampleCount = 2400;
		const original = readInt16LEArray(makeSine(300, 8000, sampleCount, amplitude));
		const restored = readInt16LEArray(
			downsample24kTo8k(upsample8kTo24k(writeInt16LEArray(original)))
		);

		// The chain is causal, so the output is delayed by a known whole number of
		// 8 kHz samples (that is why the tap count was chosen as it was).
		const delay = RESAMPLE_ROUND_TRIP_DELAY_8K;
		// Skip the FIR ramp-in; a fresh filter starts with a zeroed history.
		const skip = 32;

		let worst = 0;
		let squaredErrorSum = 0;
		let compared = 0;

		for (let i = skip; i + delay < restored.length; i++) {
			const error = Math.abs(original[i] - restored[i + delay]);

			worst = Math.max(worst, error);
			squaredErrorSum += error * error;
			compared++;
		}

		expect(compared).toBeGreaterThan(2000);

		const rmsError = Math.sqrt(squaredErrorSum / compared);

		// Tolerance justification: linear interpolation has a triangular kernel, so
		// its magnitude response is sinc^2(f / 8000). At 300 Hz that predicts a loss
		// of 1 - sinc^2(0.0375) = 0.46% of amplitude, and that term dominates the
		// error budget (FIR passband ripple at 300 Hz is ~0.01%). 0.6% of amplitude
		// gives margin without hiding a real regression - a misaligned delay or a
		// missing low-pass shows up as >10%.
		expect(worst).toBeLessThan(amplitude * 0.006);
		expect(rmsError).toBeLessThan(amplitude * 0.004);
	});

	test("downsampler rejects out-of-band energy instead of aliasing it down", () => {
		const amplitude = 12_000;
		// 3.9 kHz is above the 8 kHz Nyquist limit's usable edge. Without the
		// low-pass it would fold to |8000 - 3900| = 4100 -> 3.9 kHz mirrored into
		// the band at full level, which is the classic metallic ring.
		const outOfBand = readInt16LEArray(makeSine(3900, 24_000, 24_000, amplitude));
		const decimated = readInt16LEArray(downsample24kTo8k(writeInt16LEArray(outOfBand)));

		const inputPower = meanPower(outOfBand, 2000);
		const outputPower = meanPower(decimated, 500);

		// Measured attenuation is about -63 dB; assert a much looser -30 dB so the
		// test tracks "the filter is there and works", not window-function trivia.
		expect(outputPower / inputPower).toBeLessThan(1e-3);

		// Complement: the filter must not simply mute everything. 300 Hz is deep in
		// the passband and has to come through at essentially full power.
		const inBand = readInt16LEArray(makeSine(300, 24_000, 24_000, amplitude));
		const inBandOut = readInt16LEArray(downsample24kTo8k(writeInt16LEArray(inBand)));
		const passRatio = meanPower(inBandOut, 500) / meanPower(inBand, 2000);

		expect(passRatio).toBeGreaterThan(0.9);
		expect(passRatio).toBeLessThan(1.1);
		expect(DOWNSAMPLE_CUTOFF_HZ).toBe(3400);
	});

	test("streaming a buffer in 3 chunks equals processing it whole (downsampler)", () => {
		const source = makeSine(700, 24_000, 3000, 9000);
		const whole = downsample24kTo8k(source);

		const streaming = createDownsampler24kTo8k();
		// Deliberately ugly split points: not multiples of 3 samples, and the first
		// two land on an odd byte so half a sample is carried over.
		const chunks = [source.subarray(0, 1001), source.subarray(1001, 3777), source.subarray(3777)];
		const chunked = Buffer.concat(chunks.map((chunk) => streaming.process(chunk)));

		expect(chunked.length).toBe(whole.length);
		// Byte-exact: this is the whole reason the FIR history and the decimation
		// phase live in the closure instead of being reset per chunk.
		expect(chunked.equals(whole)).toBe(true);
	});

	test("streaming a buffer in 3 chunks equals processing it whole (upsampler)", () => {
		const source = makeSine(700, 8000, 1000, 9000);
		const whole = upsample8kTo24k(source);

		const streaming = createUpsampler8kTo24k();
		const chunks = [source.subarray(0, 333), source.subarray(333, 1111), source.subarray(1111)];
		const chunked = Buffer.concat(chunks.map((chunk) => streaming.process(chunk)));

		expect(chunked.length).toBe(whole.length);
		expect(chunked.equals(whole)).toBe(true);
	});

	test("decimation phase is preserved across chunk boundaries", () => {
		const source = makeSine(700, 24_000, 9, 9000);
		const streaming = createDownsampler24kTo8k();

		// One sample at a time: only every third call may produce output.
		const perSample: number[] = [];
		for (let i = 0; i < 9; i++) {
			const out = streaming.process(
				source.subarray(i * BYTES_PER_SAMPLE, (i + 1) * BYTES_PER_SAMPLE)
			);
			perSample.push(out.length / BYTES_PER_SAMPLE);
		}

		expect(perSample).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
	});

	test("reset() returns a resampler to its initial state", () => {
		const source = makeSine(700, 24_000, 600, 9000);
		const streaming = createDownsampler24kTo8k();

		const first = streaming.process(source);
		streaming.reset();
		const second = streaming.process(source);

		expect(second.equals(first)).toBe(true);

		const upSource = makeSine(700, 8000, 200, 9000);
		const upStreaming = createUpsampler8kTo24k();
		const firstUp = upStreaming.process(upSource);
		upStreaming.reset();

		expect(upStreaming.process(upSource).equals(firstUp)).toBe(true);
	});

	test("resamplers saturate on full-scale input rather than wrapping", () => {
		// A full-scale square wave is the worst case for a windowed-sinc FIR: the
		// step response overshoots past full scale, so the output must clip.
		const squareWave = new Int16Array(600);
		for (let i = 0; i < squareWave.length; i++) {
			squareWave[i] = i % 60 < 30 ? INT16_MAX : INT16_MIN;
		}

		const downsampled = readInt16LEArray(downsample24kTo8k(writeInt16LEArray(squareWave)));
		const upsampled = readInt16LEArray(upsample8kTo24k(writeInt16LEArray(squareWave)));

		for (const value of downsampled) {
			expect(value).toBeGreaterThanOrEqual(INT16_MIN);
			expect(value).toBeLessThanOrEqual(INT16_MAX);
		}

		// Interpolation never leaves the interval spanned by its endpoints, so the
		// upsampled square wave must still be exactly full scale everywhere it is
		// not on a transition ramp.
		expect(Math.max(...upsampled)).toBe(INT16_MAX);
		expect(Math.min(...upsampled)).toBe(INT16_MIN);
	});
});

// ===========================================
// int16 helpers
// ===========================================

describe("int16 helpers", () => {
	test("clampInt16 saturates instead of wrapping", () => {
		expect(clampInt16(0)).toBe(0);
		expect(clampInt16(INT16_MAX)).toBe(INT16_MAX);
		expect(clampInt16(INT16_MIN)).toBe(INT16_MIN);

		// Wrapping would give -32768 and 32767 respectively.
		expect(clampInt16(INT16_MAX + 1)).toBe(INT16_MAX);
		expect(clampInt16(INT16_MIN - 1)).toBe(INT16_MIN);

		expect(clampInt16(1e9)).toBe(INT16_MAX);
		expect(clampInt16(-1e9)).toBe(INT16_MIN);

		// Fractional input from interpolation/filtering is rounded, not truncated.
		expect(clampInt16(1.4)).toBe(1);
		expect(clampInt16(1.5)).toBe(2);
		expect(clampInt16(-2.5)).toBe(-2);

		// A NaN gain calculation must degrade to silence, never to a random byte.
		expect(clampInt16(Number.NaN)).toBe(0);
		expect(clampInt16(Number.POSITIVE_INFINITY)).toBe(0);
	});

	test("writeInt16LEArray clamps every sample", () => {
		const written = writeInt16LEArray([0, 40_000, -40_000, 32_767, -32_768]);
		const read = readInt16LEArray(written);

		expect(Array.from(read)).toEqual([0, INT16_MAX, INT16_MIN, INT16_MAX, INT16_MIN]);
		// Proof it is saturation and not truncation: 40000 as a wrapped int16 is
		// -25536, which would have shown up as a sign flip above.
		expect(read[1]).toBeGreaterThan(0);
		expect(read[2]).toBeLessThan(0);
	});

	test("readInt16LEArray round-trips and ignores a trailing odd byte", () => {
		const samples = [0, 1, -1, 12_345, -12_345, INT16_MAX, INT16_MIN];
		const buffer = writeInt16LEArray(samples);

		expect(buffer.length).toBe(samples.length * BYTES_PER_SAMPLE);
		expect(Array.from(readInt16LEArray(buffer))).toEqual(samples);

		const truncated = Buffer.concat([buffer, Buffer.from([0x01])]);
		expect(readInt16LEArray(truncated).length).toBe(samples.length);
		expect(Array.from(readInt16LEArray(truncated))).toEqual(samples);
	});
});

// ===========================================
// Presence EQ + peak limiter
// ===========================================

const RATE_24K = 24_000;

/** Largest magnitude any sample in a slin buffer reaches. */
function peakOf(pcm: Buffer): number {
	let peak = 0;

	for (let i = 0; i + 1 < pcm.length; i += BYTES_PER_SAMPLE) {
		const magnitude = Math.abs(pcm.readInt16LE(i));

		if (magnitude > peak) {
			peak = magnitude;
		}
	}

	return peak;
}

/**
 * Energy at one frequency, by Goertzel. Used instead of a full FFT because the
 * only question these tests ask is "how much of THIS tone came out".
 */
function toneEnergy(pcm: Buffer, hz: number, sampleRate: number, skipSamples: number): number {
	const coefficient = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
	const count = pcm.length / BYTES_PER_SAMPLE;
	let s1 = 0;
	let s2 = 0;

	for (let i = skipSamples; i < count; i++) {
		const s0 = pcm.readInt16LE(i * BYTES_PER_SAMPLE) + coefficient * s1 - s2;
		s2 = s1;
		s1 = s0;
	}

	return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
}

/** How much louder one tone comes out of a lifted chain than a bypassed one. */
function toneGainDb(hz: number, presenceDb: number): number {
	// Quiet enough that the limiter never engages, so this measures the bell and
	// only the bell.
	const input = makeSine(hz, RATE_24K, RATE_24K, 2000);

	const plain = createAgentVoiceChain().process(input);
	const lifted = createAgentVoiceChain({ presenceDb }).process(input);

	// Past the FIR transient and the look-ahead priming.
	const skip = 400;

	return 10 * Math.log10(toneEnergy(lifted, hz, 8000, skip) / toneEnergy(plain, hz, 8000, skip));
}

describe("the presence bell", () => {
	test("lifts its centre by exactly the dB it was asked for, and nothing at DC", () => {
		for (const gainDb of [3, 6, 9, 12]) {
			const bell = designPeakingBiquad(gainDb);

			expect(biquadMagnitudeDb(bell, PRESENCE_CENTRE_HZ)).toBeCloseTo(gainDb, 6);
			// A peaking filter must be unity a long way either side of the bell,
			// otherwise it is a shelf and it would change the voice's whole timbre.
			expect(biquadMagnitudeDb(bell, 1)).toBeCloseTo(0, 3);
			expect(biquadMagnitudeDb(bell, RATE_24K / 2)).toBeCloseTo(0, 3);
		}
	});

	test("covers the whole consonant band, which is the entire point of it", () => {
		const bell = designPeakingBiquad(6);

		// 1.2-3.4 kHz is the band a telephone carries consonants in. Every part of
		// it has to come up by a useful amount - a narrow bell on 2.1 kHz would
		// leave both ends exactly where they were.
		expect(biquadMagnitudeDb(bell, 1200)).toBeGreaterThan(3.5);
		expect(biquadMagnitudeDb(bell, 2000)).toBeGreaterThan(5.5);
		expect(biquadMagnitudeDb(bell, 3000)).toBeGreaterThan(4.5);
		expect(biquadMagnitudeDb(bell, 3400)).toBeGreaterThan(3.5);

		// ...while the vowel band below 700 Hz is left roughly alone, so the voice
		// still sounds like the voice the business chose.
		expect(biquadMagnitudeDb(bell, 400)).toBeLessThan(1.5);
	});

	test("0 dB is a straight wire", () => {
		const bell = designPeakingBiquad(0);

		for (const hz of [100, 500, 1200, 2100, 3400, 7000]) {
			expect(biquadMagnitudeDb(bell, hz)).toBeCloseTo(0, 9);
		}
	});

	test("the gain it claims on paper is the gain a real tone gets", () => {
		// The design and the running filter are separate code paths; this is the
		// test that proves they agree end to end, decimation included.
		const bell = designPeakingBiquad(6);

		for (const hz of [1200, 2100, 3000]) {
			expect(toneGainDb(hz, 6)).toBeCloseTo(biquadMagnitudeDb(bell, hz), 0);
		}
	});
});

describe("the agent voice chain", () => {
	test("with both knobs at zero it is byte-identical to a bare downsampler", () => {
		const input = Buffer.concat([
			makeSine(300, RATE_24K, 4000, 20_000),
			makeSine(2100, RATE_24K, 4000, 20_000),
		]);

		const chain = createAgentVoiceChain();
		const reference = createDownsampler24kTo8k();

		expect(chain.bypassed).toBe(true);
		expect(chain.presence).toBeNull();
		expect(chain.peakReductionDb).toBe(0);

		// Chunked the way a live call chunks it, both sides identically.
		for (let offset = 0; offset < input.length; offset += 1918) {
			const slice = input.subarray(offset, Math.min(offset + 1918, input.length));

			expect(chain.process(slice)).toEqual(reference.process(slice));
		}
	});

	test("an explicit zero disables it just as surely as saying nothing", () => {
		expect(createAgentVoiceChain({ presenceDb: 0, outputGainDb: 0 }).bypassed).toBe(true);
		expect(createAgentVoiceChain({ presenceDb: 6 }).bypassed).toBe(false);
		expect(createAgentVoiceChain({ outputGainDb: 3 }).bypassed).toBe(false);
		// A knob that arrived as NaN from a hand-edited settings row must not
		// silently become a filter nobody asked for.
		expect(createAgentVoiceChain({ presenceDb: Number.NaN }).bypassed).toBe(true);
	});

	test("clamps knobs that are out of range instead of trusting them", () => {
		const tooLoud = createAgentVoiceChain({ presenceDb: 99, outputGainDb: 99 });
		const atMax = createAgentVoiceChain({
			presenceDb: PRESENCE_MAX_DB,
			outputGainDb: OUTPUT_GAIN_MAX_DB,
		});

		expect(tooLoud.presence).toEqual(atMax.presence);

		const input = makeSine(2100, RATE_24K, 2400, 12_000);

		expect(tooLoud.process(input)).toEqual(atMax.process(input));

		// Negative is not "cut the presence band", it is a typo; treat it as off.
		expect(createAgentVoiceChain({ presenceDb: -6, outputGainDb: -6 }).bypassed).toBe(true);
	});

	test("no sample reaches full scale, whatever is fed to it", () => {
		// Every one of these is far nastier than speech. u-law - which is what a
		// real call re-encodes to - saturates below int16 does, at 32124, so that
		// is the bar rather than 32767.
		const nasty: Record<string, Buffer> = {
			"full-scale square 200 Hz": writeInt16LEArray(
				Array.from({ length: RATE_24K }, (_, i) =>
					Math.sin((2 * Math.PI * 200 * i) / RATE_24K) >= 0 ? INT16_MAX : INT16_MIN
				)
			),
			"full-scale sine 2100 Hz": makeSine(2100, RATE_24K, RATE_24K, INT16_MAX),
			"full-scale sine 400 Hz": makeSine(400, RATE_24K, RATE_24K, INT16_MAX),
			"alternating full scale": writeInt16LEArray(
				Array.from({ length: RATE_24K }, (_, i) => (i % 2 === 0 ? INT16_MAX : INT16_MIN))
			),
			"full-scale impulses": writeInt16LEArray(
				Array.from({ length: RATE_24K }, (_, i) => (i % 53 === 0 ? INT16_MAX : 0))
			),
		};

		for (const [presenceDb, outputGainDb] of [
			[6, 3],
			[PRESENCE_MAX_DB, OUTPUT_GAIN_MAX_DB],
		]) {
			for (const [name, input] of Object.entries(nasty)) {
				const chain = createAgentVoiceChain({ presenceDb, outputGainDb });
				let peak = 0;

				for (let offset = 0; offset < input.length; offset += 1918) {
					peak = Math.max(
						peak,
						peakOf(chain.process(input.subarray(offset, Math.min(offset + 1918, input.length))))
					);
				}

				// The case name rides along so a failure says WHICH signal broke it.
				expect({ name, presenceDb, withinUlaw: peak <= MU_LAW_FULL_SCALE }).toEqual({
					name,
					presenceDb,
					withinUlaw: true,
				});
			}
		}
	});

	test("holds a deliberately over-loud input at the ceiling and says how hard it worked", () => {
		// +12 dB of make-up on a signal already at half scale asks for roughly
		// double full scale; the limiter has to give every dB of that back.
		const chain = createAgentVoiceChain({ outputGainDb: OUTPUT_GAIN_MAX_DB });
		const peak = peakOf(chain.process(makeSine(400, RATE_24K, RATE_24K, INT16_MAX / 2)));

		expect(peak).toBeLessThanOrEqual(MU_LAW_FULL_SCALE);
		// It must not have simply thrown the level away either: a limiter that
		// over-attenuates is as wrong as one that clips.
		expect(peak).toBeGreaterThan(LIMITER_CEILING_SAMPLE * 0.9);
		expect(chain.peakReductionDb).toBeLessThan(-5);
		expect(chain.peakReductionDb).toBeGreaterThan(-13);
	});

	test("leaves a quiet signal completely alone - the limiter is not a compressor", () => {
		const chain = createAgentVoiceChain({ presenceDb: 6, outputGainDb: 3 });
		// -20 dBFS at 400 Hz: the bell hardly touches it and the make-up gain keeps
		// it far under the ceiling, so nothing should engage at all.
		chain.process(makeSine(400, RATE_24K, RATE_24K, INT16_MAX / 10));

		expect(chain.peakReductionDb).toBe(0);
	});

	test("streaming in chunks equals processing the buffer whole", () => {
		const input = Buffer.concat([
			makeSine(700, RATE_24K, 3000, 26_000),
			makeSine(2100, RATE_24K, 3000, 30_000),
		]);

		const whole = createAgentVoiceChain({ presenceDb: 6, outputGainDb: 3 }).process(input);

		const streamed = createAgentVoiceChain({ presenceDb: 6, outputGainDb: 3 });
		const pieces: Buffer[] = [];
		let taken = 0;

		// Deliberately awkward sizes, including an ODD BYTE count, because a base64
		// audio part is not a whole number of samples in general.
		for (const size of [1, 317, 2049, 5, 999_999]) {
			if (taken >= input.length) {
				break;
			}

			const end = Math.min(taken + size, input.length);

			pieces.push(streamed.process(input.subarray(taken, end)));
			taken = end;
		}

		const chunked = Buffer.concat(pieces);

		expect(chunked.length).toBe(whole.length);
		// Byte-exact. This is why the bell, the limiter and the FIR all live in one
		// closure per call instead of being rebuilt for each audio part.
		expect(chunked.equals(whole)).toBe(true);
	});

	test("keeps the downsampler's length contract, odd trailing byte included", () => {
		const chain = createAgentVoiceChain({ presenceDb: 6, outputGainDb: 3 });
		const input = makeSine(1000, RATE_24K, 900, 10_000);

		expect(chain.process(input).length / BYTES_PER_SAMPLE).toBe(900 / RESAMPLE_FACTOR);

		// A buffer split mid-sample must not lose or invent one.
		const split = createAgentVoiceChain({ presenceDb: 6, outputGainDb: 3 });
		const first = split.process(input.subarray(0, 601));
		const second = split.process(input.subarray(601));

		expect((first.length + second.length) / BYTES_PER_SAMPLE).toBe(900 / RESAMPLE_FACTOR);
	});

	test("reset() returns it to the state a fresh chain is in", () => {
		const chain = createAgentVoiceChain({ presenceDb: 6, outputGainDb: 3 });
		const input = makeSine(2100, RATE_24K, 2400, INT16_MAX);

		const first = chain.process(input);

		expect(chain.peakReductionDb).toBeLessThan(0);

		chain.reset();

		expect(chain.peakReductionDb).toBe(0);
		expect(chain.process(input)).toEqual(first);
	});

	test("delays the voice by the look-ahead and no more", () => {
		// The limiter can only be transparent because it sees a peak before it
		// plays it, and that costs latency. 2 ms is the budget; more than that
		// starts eating into the turn-taking timings the VAD settings assume.
		expect(LIMITER_LOOKAHEAD_SAMPLES / RATE_24K).toBeLessThanOrEqual(0.002);

		const chain = createAgentVoiceChain({ presenceDb: 6, outputGainDb: 3 });
		const out = chain.process(makeSine(1000, RATE_24K, 2400, 20_000));
		const count = out.length / BYTES_PER_SAMPLE;

		// The leading silence is the look-ahead expressed at 8 kHz plus the FIR's
		// own group delay - a handful of samples, not a syllable.
		let firstNonZero = 0;
		while (firstNonZero < count && out.readInt16LE(firstNonZero * BYTES_PER_SAMPLE) === 0) {
			firstNonZero++;
		}

		expect(firstNonZero).toBeLessThan(
			LIMITER_LOOKAHEAD_SAMPLES / RESAMPLE_FACTOR + RESAMPLE_ROUND_TRIP_DELAY_8K
		);
	});

	test("the ceiling leaves G.711 room to encode into", () => {
		// The chain runs at 24 kHz and the decimating FIR afterwards resolves peaks
		// that fell between its samples, so the ceiling has to sit low enough that
		// the overshoot still clears u-law. This is that margin, as a number.
		expect(20 * Math.log10(LIMITER_CEILING)).toBeCloseTo(-2, 6);
		// At least 1 dB under u-law's own full scale, which is where the measured
		// worst-case decimation overshoot has to fit.
		expect(20 * Math.log10(MU_LAW_FULL_SCALE / (INT16_MAX + 1) / LIMITER_CEILING)).toBeGreaterThan(
			1
		);
	});
});
