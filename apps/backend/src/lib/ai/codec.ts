/**
 * Audio codec / resampling primitives for the AI voice bridge.
 *
 * Pure functions only - no I/O, no env, no logging, so this module is cheap to
 * import from tests and from hot audio paths.
 *
 * Sample-rate map of the bridge:
 *
 *   Asterisk AudioSocket  <--- slin  (signed linear PCM16, 8 kHz, mono, LE) --->
 *   OpenAI Realtime GA    <--- either audio/pcmu (G.711 u-law 8 kHz)
 *                              or     audio/pcm  (PCM16 24 kHz)             --->
 *
 * So two conversions are needed:
 *   1. slin8k <-> G.711 u-law   (muLawEncode / muLawDecode)
 *   2. slin8k <-> PCM16 24 kHz  (upsample8kTo24k / downsample24kTo8k)
 *
 * Everything is little-endian int16 in `Buffer`s because that is what both
 * Asterisk ("slin") and OpenAI ("pcm16") put on the wire.
 */
import { Buffer } from "node:buffer";

// ===========================================
// int16 helpers
// ===========================================

export const INT16_MIN = -32768;
export const INT16_MAX = 32767;

/** Bytes per PCM16 sample. */
export const BYTES_PER_SAMPLE = 2;

/** G.711 u-law encoding of digital silence (linear 0). */
export const MU_LAW_SILENCE = 0xff;

/**
 * Saturating int16 conversion: values outside the int16 range clip to the
 * nearest representable value instead of wrapping around.
 *
 * Wrapping is the classic audio bug - a slightly-too-loud sample flips sign and
 * you hear a hard click instead of mild clipping.
 */
export function clampInt16(value: number): number {
	// Non-finite input (NaN/Infinity from a bad gain calculation) becomes silence
	// rather than an unpredictable byte pattern.
	if (!Number.isFinite(value)) {
		return 0;
	}

	const rounded = Math.round(value);

	if (rounded > INT16_MAX) {
		return INT16_MAX;
	}
	if (rounded < INT16_MIN) {
		return INT16_MIN;
	}
	return rounded;
}

/**
 * Read a little-endian PCM16 buffer into an Int16Array.
 *
 * A trailing odd byte (possible when a TCP read splits a sample) is ignored -
 * the stateful resamplers carry it over instead, see createUpsampler8kTo24k().
 */
export function readInt16LEArray(pcm16: Buffer): Int16Array {
	const sampleCount = pcm16.length >> 1;
	const out = new Int16Array(sampleCount);

	for (let i = 0; i < sampleCount; i++) {
		out[i] = pcm16.readInt16LE(i * BYTES_PER_SAMPLE);
	}

	return out;
}

/** Write samples as little-endian PCM16, saturating instead of wrapping. */
export function writeInt16LEArray(samples: ArrayLike<number>): Buffer {
	const out = Buffer.allocUnsafe(samples.length * BYTES_PER_SAMPLE);

	for (let i = 0; i < samples.length; i++) {
		out.writeInt16LE(clampInt16(samples[i]), i * BYTES_PER_SAMPLE);
	}

	return out;
}

// ===========================================
// G.711 u-law companding (ITU-T G.711)
// ===========================================

/**
 * Standard u-law bias (0x84 = 132) added to the 14-bit magnitude before the
 * segment search. It is what makes the exponent/mantissa split exact.
 */
const MU_LAW_BIAS = 0x84;

/** Largest 14-bit magnitude u-law can express (32635 >> 2). */
const MU_LAW_CLIP_14BIT = 8159;

/** Upper bound of each of the 8 u-law segments, in the biased 14-bit domain. */
const MU_LAW_SEGMENT_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];

const MU_LAW_QUANT_MASK = 0x0f;
const MU_LAW_SEGMENT_MASK = 0x70;
const MU_LAW_SEGMENT_SHIFT = 4;
const MU_LAW_SIGN_BIT = 0x80;

function findMuLawSegment(biasedMagnitude: number): number {
	for (let segment = 0; segment < MU_LAW_SEGMENT_END.length; segment++) {
		if (biasedMagnitude <= MU_LAW_SEGMENT_END[segment]) {
			return segment;
		}
	}
	return MU_LAW_SEGMENT_END.length;
}

/**
 * Encode one linear PCM16 sample to a G.711 u-law byte.
 *
 * Reference algorithm (ITU-T G.711 / the canonical Sun `g711.c`):
 *   1. drop to 14-bit magnitude + sign
 *   2. clip the magnitude at 8159
 *   3. add the bias, find the segment (exponent), take 4 mantissa bits
 *   4. complement the result (u-law is stored inverted)
 *
 * Sanity anchors: 0 -> 0xff, +32124 -> 0x80, -32124 -> 0x00.
 */
export function muLawEncodeSample(sample: number): number {
	let magnitude = clampInt16(sample) >> 2;
	let mask: number;

	if (magnitude < 0) {
		magnitude = -magnitude;
		mask = 0x7f;
	} else {
		mask = 0xff;
	}

	if (magnitude > MU_LAW_CLIP_14BIT) {
		magnitude = MU_LAW_CLIP_14BIT;
	}

	magnitude += MU_LAW_BIAS >> 2;

	const segment = findMuLawSegment(magnitude);

	// Out of range - can only happen if the clip above is ever removed.
	if (segment >= MU_LAW_SEGMENT_END.length) {
		return (0x7f ^ mask) & 0xff;
	}

	const mantissa = (magnitude >> (segment + 1)) & MU_LAW_QUANT_MASK;
	return (((segment << MU_LAW_SEGMENT_SHIFT) | mantissa) ^ mask) & 0xff;
}

function decodeMuLawByte(byte: number): number {
	// u-law is stored complemented.
	const value = ~byte & 0xff;

	const mantissa = value & MU_LAW_QUANT_MASK;
	const segment = (value & MU_LAW_SEGMENT_MASK) >> MU_LAW_SEGMENT_SHIFT;

	// Re-introduce the implicit bit and the bias, then scale by the segment.
	const magnitude = ((mantissa << 3) + MU_LAW_BIAS) << segment;

	return (value & MU_LAW_SIGN_BIT) === 0 ? magnitude - MU_LAW_BIAS : MU_LAW_BIAS - magnitude;
}

/**
 * 256-entry decode table, built once at module load. Decoding is a table lookup
 * on the hot path; there are only 256 possible inputs so this is exact, not an
 * approximation.
 */
const MU_LAW_DECODE_TABLE: Int16Array = (() => {
	const table = new Int16Array(256);
	for (let byte = 0; byte < 256; byte++) {
		table[byte] = decodeMuLawByte(byte);
	}
	return table;
})();

/** Decode one G.711 u-law byte to a linear PCM16 sample. */
export function muLawDecodeSample(byte: number): number {
	return MU_LAW_DECODE_TABLE[byte & 0xff];
}

/**
 * slin 8 kHz (PCM16 LE) -> G.711 u-law. Output length is exactly half the
 * number of whole input samples; a trailing odd byte is ignored.
 */
export function muLawEncode(pcm16: Buffer): Buffer {
	const sampleCount = pcm16.length >> 1;
	const out = Buffer.allocUnsafe(sampleCount);

	for (let i = 0; i < sampleCount; i++) {
		out[i] = muLawEncodeSample(pcm16.readInt16LE(i * BYTES_PER_SAMPLE));
	}

	return out;
}

/** G.711 u-law -> slin 8 kHz (PCM16 LE). Output length is exactly 2x input. */
export function muLawDecode(ulaw: Buffer): Buffer {
	const out = Buffer.allocUnsafe(ulaw.length * BYTES_PER_SAMPLE);

	for (let i = 0; i < ulaw.length; i++) {
		out.writeInt16LE(MU_LAW_DECODE_TABLE[ulaw[i]], i * BYTES_PER_SAMPLE);
	}

	return out;
}

// ===========================================
// Resampling 8 kHz <-> 24 kHz
// ===========================================

/** 24000 / 8000. */
export const RESAMPLE_FACTOR = 3;

/**
 * Anti-alias FIR length. Two constraints picked this number:
 *
 *  1. 3.4 kHz has to pass and 4 kHz (the 8 kHz Nyquist limit) has to be gone.
 *     A Hamming window needs roughly 3.3/N normalised transition width, so
 *     N = 129 at 24 kHz gives ~615 Hz of transition (3.1 kHz .. 3.7 kHz) with
 *     ~-53 dB stopband. A 13-tap filter cannot do this - its transition band is
 *     ~6 kHz wide, i.e. it would not attenuate the aliasing region at all.
 *  2. (TAPS - 1) / 2 must be congruent to 1 (mod 3) so that the total
 *     8k -> 24k -> 8k group delay is a whole number of 8 kHz samples, which
 *     keeps round-trip comparisons (and lip sync) exact. 129 -> 64, 64 % 3 == 1.
 */
export const DOWNSAMPLE_FIR_TAPS = 129;

/** -6 dB point of the anti-alias filter (classic telephony band edge). */
export const DOWNSAMPLE_CUTOFF_HZ = 3400;

const RATE_24K = 24000;

/** FIR group delay, in 24 kHz samples. */
export const DOWNSAMPLE_GROUP_DELAY_24K = (DOWNSAMPLE_FIR_TAPS - 1) / 2;

/**
 * Group delay of upsample8kTo24k -> downsample24kTo8k, in 8 kHz samples:
 * 2 samples at 24 kHz from the causal interpolator plus the FIR delay,
 * divided by 3. With 129 taps: (2 + 64) / 3 = 22.
 */
export const RESAMPLE_ROUND_TRIP_DELAY_8K = (2 + DOWNSAMPLE_GROUP_DELAY_24K) / RESAMPLE_FACTOR;

/**
 * Hamming-windowed sinc low-pass, normalised to unity DC gain.
 *
 * Unity (not `RESAMPLE_FACTOR`) gain is right here: the filter runs on an
 * already-interpolated 24 kHz stream, it is a decimation guard, not an
 * interpolation reconstruction filter.
 */
function designLowPass(taps: number, cutoffHz: number, sampleRate: number): Float64Array {
	const coefficients = new Float64Array(taps);
	const center = (taps - 1) / 2;
	const omega = (2 * Math.PI * cutoffHz) / sampleRate;
	let sum = 0;

	for (let i = 0; i < taps; i++) {
		const n = i - center;
		const ideal = n === 0 ? omega / Math.PI : Math.sin(omega * n) / (Math.PI * n);
		const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
		const value = ideal * window;

		coefficients[i] = value;
		sum += value;
	}

	for (let i = 0; i < taps; i++) {
		coefficients[i] = coefficients[i] / sum;
	}

	return coefficients;
}

const DOWNSAMPLE_COEFFICIENTS = designLowPass(DOWNSAMPLE_FIR_TAPS, DOWNSAMPLE_CUTOFF_HZ, RATE_24K);

/**
 * A streaming sample-rate converter.
 *
 * `process()` may be called with arbitrarily chunked buffers - including buffers
 * with an odd byte count, whose trailing byte is held until the rest of the
 * sample arrives. Filter/interpolator state is carried across calls so chunk
 * boundaries do not click, which is exactly why this factory exists next to the
 * one-shot helpers.
 */
export interface Resampler {
	/** Convert one chunk. Returns the samples that are ready. */
	process(input: Buffer): Buffer;
	/** Drop all state (call between calls, never mid-call). */
	reset(): void;
}

/**
 * slin 8 kHz -> PCM16 24 kHz by linear interpolation (factor 3).
 *
 * The interpolation is causal: output triple `3i, 3i+1, 3i+2` interpolates from
 * the *previous* input sample up to input sample `i`, so `x[i]` lands exactly on
 * output index `3i+2` and every chunk produces exactly 3 output samples per
 * input sample. A non-causal variant would need one sample of lookahead and
 * would therefore have to withhold the last sample of every chunk.
 *
 * Initial state is silence, which is what an audio stream starts from anyway.
 */
export function createUpsampler8kTo24k(): Resampler {
	let previous = 0;
	let pendingByte = -1;

	return {
		process(input: Buffer): Buffer {
			let source = input;

			if (pendingByte >= 0) {
				source = Buffer.concat([Buffer.from([pendingByte]), input]);
				pendingByte = -1;
			}

			const sampleCount = source.length >> 1;

			if ((source.length & 1) === 1) {
				pendingByte = source[source.length - 1];
			}

			const out = Buffer.allocUnsafe(sampleCount * RESAMPLE_FACTOR * BYTES_PER_SAMPLE);
			let offset = 0;

			for (let i = 0; i < sampleCount; i++) {
				const current = source.readInt16LE(i * BYTES_PER_SAMPLE);
				const delta = current - previous;

				out.writeInt16LE(clampInt16(previous + delta / 3), offset);
				offset += BYTES_PER_SAMPLE;
				out.writeInt16LE(clampInt16(previous + (2 * delta) / 3), offset);
				offset += BYTES_PER_SAMPLE;
				out.writeInt16LE(current, offset);
				offset += BYTES_PER_SAMPLE;

				previous = current;
			}

			return out;
		},

		reset(): void {
			previous = 0;
			pendingByte = -1;
		},
	};
}

/**
 * PCM16 24 kHz -> slin 8 kHz: low-pass first, then keep every third sample.
 *
 * Decimating without the low-pass folds everything above 4 kHz back into the
 * band as aliasing - it is the metallic ringing you hear when someone forgets
 * this step. The FIR history is kept across `process()` calls so chunked input
 * produces bit-identical output to processing the whole buffer at once.
 */
export function createDownsampler24kTo8k(): Resampler {
	const taps = DOWNSAMPLE_FIR_TAPS;
	const history = new Float64Array(taps);
	/** Index of the newest sample inside the `history` ring buffer. */
	let newest = taps - 1;
	/** Input samples still to skip before the next output sample. */
	let phase = 0;
	let pendingByte = -1;

	const filter = (): number => {
		const coefficients = DOWNSAMPLE_COEFFICIENTS;
		let accumulator = 0;
		let index = newest;

		for (let k = 0; k < taps; k++) {
			accumulator += coefficients[k] * history[index];
			index--;
			if (index < 0) {
				index = taps - 1;
			}
		}

		return accumulator;
	};

	return {
		process(input: Buffer): Buffer {
			let source = input;

			if (pendingByte >= 0) {
				source = Buffer.concat([Buffer.from([pendingByte]), input]);
				pendingByte = -1;
			}

			const sampleCount = source.length >> 1;

			if ((source.length & 1) === 1) {
				pendingByte = source[source.length - 1];
			}

			const outputCount =
				sampleCount > phase ? Math.ceil((sampleCount - phase) / RESAMPLE_FACTOR) : 0;
			const out = Buffer.allocUnsafe(outputCount * BYTES_PER_SAMPLE);
			let offset = 0;

			for (let i = 0; i < sampleCount; i++) {
				newest = newest + 1 === taps ? 0 : newest + 1;
				history[newest] = source.readInt16LE(i * BYTES_PER_SAMPLE);

				if (phase === 0) {
					out.writeInt16LE(clampInt16(filter()), offset);
					offset += BYTES_PER_SAMPLE;
					phase = RESAMPLE_FACTOR - 1;
				} else {
					phase--;
				}
			}

			return out;
		},

		reset(): void {
			history.fill(0);
			newest = taps - 1;
			phase = 0;
			pendingByte = -1;
		},
	};
}

/**
 * One-shot slin 8 kHz -> PCM16 24 kHz. Output is exactly 3x the input sample
 * count. Identical to a fresh createUpsampler8kTo24k() fed the whole buffer.
 */
export function upsample8kTo24k(pcm8k: Buffer): Buffer {
	return createUpsampler8kTo24k().process(pcm8k);
}

/**
 * One-shot PCM16 24 kHz -> slin 8 kHz. Output is ceil(n / 3) samples. Identical
 * to a fresh createDownsampler24kTo8k() fed the whole buffer, which means the
 * first `DOWNSAMPLE_GROUP_DELAY_24K` input samples ramp in from a zeroed filter
 * history - use the stateful version for streams.
 */
export function downsample24kTo8k(pcm24k: Buffer): Buffer {
	return createDownsampler24kTo8k().process(pcm24k);
}

// ===========================================
// Presence EQ + peak limiter
// ===========================================

/**
 * Why any of this exists.
 *
 * A telephone carries 300-3400 Hz. Vowels sit at the bottom of that, consonants
 * at the top - and consonants are what the ear reads words from, so a voice with
 * no energy above ~1.2 kHz arrives intelligible-in-principle and muffled in
 * practice. Measured on this deployment, a 296 s call recording had:
 *
 *    300-700 Hz    0.0 dB      2000-3000 Hz  -21.0 dB
 *    700-1200 Hz  -8.2 dB      3000-3600 Hz  -31.9 dB
 *   1200-2000 Hz -15.5 dB
 *
 * The identical roll-off is in the model's RAW 24 kHz TTS, before this pipeline
 * touches it (2000-3000 Hz at -24.2 dB), so it is the source voice and not the
 * resampler. The anti-alias FIR above is correct and stays untouched; what the
 * line needs is compensation, which is what the bell below is.
 */

/**
 * Centre of the presence bell, in Hz.
 *
 * sqrt(1200 * 3400) = 2020 Hz is the geometric middle of the consonant band;
 * 2100 rounds that up a little because the measured deficit grows with
 * frequency, so the bell should lean towards the top of the band.
 */
export const PRESENCE_CENTRE_HZ = 2100;

/**
 * Bell width, as Q.
 *
 * 0.65 is a shade over two octaves between the half-gain points, which is what
 * it takes to cover 1.2-3.4 kHz from a 2.1 kHz centre. Measured response of the
 * 6 dB bell, in dB:
 *
 *    400 Hz  0.5      1200 Hz  3.7      2100 Hz  6.0      3400 Hz  3.9
 *    700 Hz  1.5      1600 Hz  5.2      3000 Hz  4.7      3800 Hz  3.3
 *
 * i.e. the whole consonant band comes up by at least 3.7 dB while the vowels
 * below 700 Hz move by under 1.5 dB - the voice the business chose still sounds
 * like itself, it is just no longer behind a blanket. A narrower bell would lift
 * 2.1 kHz and leave both ends of the band exactly where they were.
 */
export const PRESENCE_Q = 0.65;

/**
 * The largest lift this module will apply.
 *
 * Past roughly 12 dB the bell stops restoring consonants and starts amplifying
 * the model's own codec noise in a band where there was very little signal to
 * begin with, which trades one kind of bad line for another.
 */
export const PRESENCE_MAX_DB = 12;

/**
 * Peak ceiling, as a fraction of int16 full scale: -2 dBFS.
 *
 * Not 0 dBFS, and the margin is sized rather than guessed.
 *
 * The bound the limiter proves is exact in the 24 kHz domain it runs in (see the
 * proof on createAgentVoiceChain), but the decimating FIR afterwards resolves
 * peaks that fell BETWEEN the 24 kHz samples it kept, so the 8 kHz output can
 * land slightly above the ceiling. That overshoot was measured rather than
 * estimated, over signals far harsher than speech - full-scale squares, sweeps,
 * impulse trains, alternating full scale and full-band white noise, at both the
 * default and the maximum setting:
 *
 *   speech and speech-like material   ~0.2 dB
 *   full-band white noise, worst case ~1.0 dB
 *
 * The filter's L1 norm would allow 6.2 dB in theory, but that needs an input
 * built to align with the FIR's sign pattern; no audio does, and pricing the
 * ceiling off it would throw away 6 dB of level for a signal that cannot occur.
 *
 * 2 dB of room therefore leaves about 0.8 dB clear on the worst measured case.
 * The bar is G.711's ceiling rather than int16's: u-law saturates at 32124 of
 * 32768, i.e. -0.17 dBFS, and a sample above that comes back distorted from a
 * codec nobody in this pipeline controls.
 *
 * This is also why the chain REMOVES the clipping the raw stream arrives with -
 * the measured recording had four clipped samples - instead of adding to it.
 */
export const LIMITER_CEILING = 10 ** (-2 / 20);

/** The ceiling in int16 counts, which is the domain the DSP runs in. */
export const LIMITER_CEILING_SAMPLE = INT16_MAX * LIMITER_CEILING;

/**
 * Look-ahead, in 24 kHz samples: 2 ms.
 *
 * It is the whole reason the limiter can be transparent. The gain is computed
 * from audio that has not been emitted yet, so it is already down by the time a
 * peak arrives instead of chasing it, and 2 ms is short enough that nobody hears
 * the delay on a line whose one-way latency is measured in tens of ms.
 */
export const LIMITER_LOOKAHEAD_SAMPLES = 48;

/**
 * Seconds for the gain to walk all the way back to unity after full attenuation.
 *
 * Short enough that the level recovers inside one pause between words; long
 * enough that it does not modulate the pitch of the vowel it just ducked, which
 * is what a release under ~50 ms sounds like.
 */
const LIMITER_RELEASE_S = 0.15;

/** How far the gain may rise per 24 kHz sample during release. */
const LIMITER_RELEASE_STEP = 1 / (LIMITER_RELEASE_S * RATE_24K);

/** The largest make-up gain the chain will apply after the bell. */
export const OUTPUT_GAIN_MAX_DB = 12;

export interface BiquadCoefficients {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

/**
 * RBJ audio-EQ-cookbook peaking filter, normalised so a0 = 1.
 *
 * Designed at 24 kHz and applied BEFORE the decimation, deliberately:
 *
 *  1. The bilinear transform warps frequency by tan(pi f / fs). At 24 kHz the
 *     2.1 kHz centre sits at 0.0875 of the rate and the bell comes out
 *     symmetrical; at 8 kHz it would sit at 0.2625, its upper skirt would fold
 *     against Nyquist, and the filter would no longer have the shape it claims.
 *  2. Everything the bell lifts above 3.4 kHz is then removed by the anti-alias
 *     FIR that already runs there, so the boost cannot alias back into the band.
 *     Boosting after the decimation would have nothing left to remove it.
 */
export function designPeakingBiquad(
	gainDb: number,
	centreHz: number = PRESENCE_CENTRE_HZ,
	q: number = PRESENCE_Q,
	sampleRate: number = RATE_24K
): BiquadCoefficients {
	const amplitude = 10 ** (gainDb / 40);
	const omega = (2 * Math.PI * centreHz) / sampleRate;
	const alpha = Math.sin(omega) / (2 * q);
	const cosine = Math.cos(omega);

	const a0 = 1 + alpha / amplitude;

	return {
		b0: (1 + alpha * amplitude) / a0,
		b1: (-2 * cosine) / a0,
		b2: (1 - alpha * amplitude) / a0,
		a1: (-2 * cosine) / a0,
		a2: (1 - alpha / amplitude) / a0,
	};
}

/**
 * Magnitude response of a biquad at one frequency, in dB.
 *
 * Exported because "this filter lifts 2 kHz by 6 dB" is a claim, and a claim in
 * an audio chain nobody can hear from a test runner has to be checkable.
 */
export function biquadMagnitudeDb(
	coefficients: BiquadCoefficients,
	hz: number,
	sampleRate: number = RATE_24K
): number {
	const omega = (2 * Math.PI * hz) / sampleRate;
	const cos1 = Math.cos(omega);
	const sin1 = Math.sin(omega);
	const cos2 = Math.cos(2 * omega);
	const sin2 = Math.sin(2 * omega);

	const numeratorReal = coefficients.b0 + coefficients.b1 * cos1 + coefficients.b2 * cos2;
	const numeratorImag = -(coefficients.b1 * sin1 + coefficients.b2 * sin2);
	const denominatorReal = 1 + coefficients.a1 * cos1 + coefficients.a2 * cos2;
	const denominatorImag = -(coefficients.a1 * sin1 + coefficients.a2 * sin2);

	const numerator = Math.hypot(numeratorReal, numeratorImag);
	const denominator = Math.hypot(denominatorReal, denominatorImag);

	return 20 * Math.log10(numerator / denominator);
}

export interface AgentVoiceChainOptions {
	/**
	 * Peaking-EQ lift at PRESENCE_CENTRE_HZ, in dB. Clamped to
	 * [0, PRESENCE_MAX_DB]. Zero leaves the spectrum alone.
	 */
	presenceDb?: number;
	/**
	 * Make-up gain applied after the bell, in dB. Clamped to
	 * [0, OUTPUT_GAIN_MAX_DB]. Zero leaves the level alone.
	 */
	outputGainDb?: number;
}

export interface AgentVoiceChain extends Resampler {
	/** True when both knobs are zero and process() is a plain downsample. */
	readonly bypassed: boolean;
	/** The bell actually in use, or null when bypassed. For logging and tests. */
	readonly presence: BiquadCoefficients | null;
	/** Largest attenuation the limiter has had to apply so far, in dB. */
	readonly peakReductionDb: number;
}

function clampGainDb(value: number | undefined, max: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return 0;
	}

	return Math.min(max, Math.max(0, value));
}

/**
 * The agent's outbound voice: presence bell -> make-up gain -> look-ahead peak
 * limiter -> anti-alias decimation to 8 kHz.
 *
 * One instance per call. It replaces a bare downsampler and keeps that
 * contract exactly - 24 kHz PCM16 LE in, slin 8 kHz out, ceil(n/3) samples,
 * arbitrary chunking, odd trailing bytes carried over - so a caller can swap it
 * in without changing anything downstream.
 *
 * With both knobs at zero it IS a bare downsampler: the same object, no bell, no
 * limiter, byte-identical output. A processing stage that cannot be switched off
 * is a stage nobody can bisect when a call sounds wrong.
 *
 * WHY THE LIMITER CANNOT CLIP, since "it should be quiet enough" is not an
 * argument. Write g_req[n] = min(1, ceiling / |x[n]|) - the largest gain sample n
 * may be given. The chain computes:
 *
 *   m[n] = min(g_req[n .. n+L-1])            sliding minimum, the look-ahead
 *   r[n] = min(m[n], r[n-1] + releaseStep)   release, which only lowers m
 *   s[n] = mean(r[n-L+1 .. n])               smoothing, which removes the steps
 *
 * Every r[i] averaged into s[n] has i in [n-L+1, n], so its window [i, i+L-1]
 * contains n, so r[i] <= m[i] <= g_req[n]. A mean of values that are each at most
 * g_req[n] is at most g_req[n]. Therefore |x[n] * s[n]| <= ceiling for EVERY
 * sample, not merely on average.
 *
 * That bound is exact at 24 kHz. The decimating FIR that follows can still
 * resolve a peak that fell between two 24 kHz samples, which is what
 * LIMITER_CEILING's 2 dB of headroom is measured and sized for; see there.
 */
export function createAgentVoiceChain(options: AgentVoiceChainOptions = {}): AgentVoiceChain {
	const presenceDb = clampGainDb(options.presenceDb, PRESENCE_MAX_DB);
	const outputGainDb = clampGainDb(options.outputGainDb, OUTPUT_GAIN_MAX_DB);
	const bypassed = presenceDb === 0 && outputGainDb === 0;

	const downsampler = createDownsampler24kTo8k();

	if (bypassed) {
		return {
			bypassed: true,
			presence: null,
			peakReductionDb: 0,
			process: (input: Buffer) => downsampler.process(input),
			reset: () => downsampler.reset(),
		};
	}

	const presence = presenceDb === 0 ? null : designPeakingBiquad(presenceDb);
	const makeUp = 10 ** (outputGainDb / 20);
	const limiter = createLookAheadLimiter();

	// Direct form II transposed: two state words, and the form that keeps its
	// precision on a low-frequency biquad even in float64.
	let z1 = 0;
	let z2 = 0;
	let pendingByte = -1;

	const runPresence = (sample: number): number => {
		if (presence === null) {
			return sample;
		}

		const output = presence.b0 * sample + z1;

		z1 = presence.b1 * sample - presence.a1 * output + z2;
		z2 = presence.b2 * sample - presence.a2 * output;

		return output;
	};

	return {
		bypassed: false,
		presence,

		get peakReductionDb(): number {
			return limiter.worstGain >= 1 ? 0 : 20 * Math.log10(limiter.worstGain);
		},

		process(input: Buffer): Buffer {
			let source = input;

			if (pendingByte >= 0) {
				source = Buffer.concat([Buffer.from([pendingByte]), input]);
				pendingByte = -1;
			}

			const sampleCount = source.length >> 1;

			if ((source.length & 1) === 1) {
				pendingByte = source[source.length - 1];
			}

			const staged = Buffer.allocUnsafe(sampleCount * BYTES_PER_SAMPLE);

			for (let i = 0; i < sampleCount; i++) {
				const lifted = runPresence(source.readInt16LE(i * BYTES_PER_SAMPLE)) * makeUp;

				staged.writeInt16LE(clampInt16(limiter.push(lifted)), i * BYTES_PER_SAMPLE);
			}

			return downsampler.process(staged);
		},

		reset(): void {
			z1 = 0;
			z2 = 0;
			pendingByte = -1;
			limiter.reset();
			downsampler.reset();
		},
	};
}

interface LookAheadLimiter {
	/**
	 * Feed one sample; get back the sample LIMITER_LOOKAHEAD_SAMPLES - 1 behind
	 * it, attenuated so that it cannot exceed LIMITER_CEILING_SAMPLE. The first
	 * calls return the silence the delay line starts full of.
	 */
	push(sample: number): number;
	reset(): void;
	/** Smallest gain applied so far, linear, in (0, 1]. 1 means it never engaged. */
	readonly worstGain: number;
}

/**
 * The limiter proved in createAgentVoiceChain's comment, on its own.
 *
 * Separate from the chain because the proof is the interesting part and it is
 * about these three stages alone - the bell in front of it changes what arrives,
 * never whether the bound holds.
 */
function createLookAheadLimiter(): LookAheadLimiter {
	const lookahead = LIMITER_LOOKAHEAD_SAMPLES;

	/** The last `lookahead` input samples, so the gain lands on a delayed signal. */
	const delayed = new Float64Array(lookahead);
	/** Monotonic deque over g_req: values ascend, so the head is the window minimum. */
	const dequeValue = new Float64Array(lookahead);
	/** Float64, not Int32: `cursor` counts every sample of a call and must not wrap. */
	const dequeIndex = new Float64Array(lookahead);
	/** Ring of r[] values; with its running sum it gives s[] in constant time. */
	const releaseRing = new Float64Array(lookahead);

	let dequeHead = 0;
	let dequeTail = 0;
	let cursor = 0;
	let release = 1;
	let releaseSum = 0;
	let ringPrimed = false;
	let worst = 1;

	/** m[]: the minimum required gain over the window ending at `cursor`. */
	const windowMinimum = (required: number): number => {
		// Expiry runs FIRST, and this order is load-bearing rather than tidy. The
		// window holds at most `lookahead` entries and the ring has exactly that many
		// slots, so inserting before expiring lets the count touch lookahead + 1: the
		// new entry lands on the head's own slot, overwrites its index with `cursor`,
		// and the pop condition can never match again. Expiring first bounds the live
		// count at lookahead - 1 before the insert.
		//
		// Measured, by scoring both orderings against a brute-force scan of the same
		// sequences: on a strictly rising `required` - a magnitude falling steadily
		// while above the ceiling, so no back-pop ever fires - the insert-first order
		// is wrong from sample 48 onward, on 19 537 of 20 000 samples, and always
		// wrong in the same direction: it reports a minimum HIGHER than the true one,
		// by up to 3.24x on an envelope whose period is just over the window. That is
		// under-attenuation, i.e. peaks the limiter should have held.
		//
		// It has not been shown to reach the output. The `release + step` cap and the
		// 48-sample mean behind it damp the error enough that no chain-level input
		// tried so far breaks the ceiling. So this is a latent correctness bug in a
		// function that must compute what it claims, not a demonstrated audible one -
		// and there is deliberately no test asserting otherwise, because a test that
		// passes on both orderings would only be decoration.
		while (dequeTail > dequeHead && dequeIndex[dequeHead % lookahead] <= cursor - lookahead) {
			dequeHead++;
		}

		while (dequeTail > dequeHead && dequeValue[(dequeTail - 1) % lookahead] >= required) {
			dequeTail--;
		}

		dequeValue[dequeTail % lookahead] = required;
		dequeIndex[dequeTail % lookahead] = cursor;
		dequeTail++;

		return dequeValue[dequeHead % lookahead];
	};

	/** s[]: the mean of the last `lookahead` release values. */
	const smooth = (value: number, slot: number): number => {
		if (ringPrimed) {
			releaseSum += value - releaseRing[slot];
			releaseRing[slot] = value;
		} else {
			// Primed with the FIRST release value rather than with 1. A 1 left in
			// here would be a gain no window ever justified, and it is the one hole
			// the safety proof would otherwise have - right at the start of a call,
			// where the greeting is.
			releaseRing.fill(value);
			releaseSum = value * lookahead;
			ringPrimed = true;
		}

		return releaseSum / lookahead;
	};

	return {
		get worstGain(): number {
			return worst;
		},

		push(sample: number): number {
			const magnitude = Math.abs(sample);
			const required = magnitude > LIMITER_CEILING_SAMPLE ? LIMITER_CEILING_SAMPLE / magnitude : 1;

			// r[]: instant attack, then walked back up over LIMITER_RELEASE_S.
			release = Math.min(windowMinimum(required), release + LIMITER_RELEASE_STEP);

			const slot = cursor % lookahead;
			const gain = smooth(release, slot);

			if (gain < worst) {
				worst = gain;
			}

			// This gain belongs to sample `cursor - lookahead + 1`, the one whose
			// whole look-ahead window has now been seen. Its slot is
			// (cursor + 1) % lookahead, because cursor - lookahead + 1 is congruent to
			// cursor + 1; the newest sample goes into cursor % lookahead, which the
			// previous call has just finished reading.
			const emit = delayed[(cursor + 1) % lookahead] * gain;

			delayed[slot] = sample;
			cursor++;

			return emit;
		},

		reset(): void {
			delayed.fill(0);
			releaseRing.fill(0);
			dequeHead = 0;
			dequeTail = 0;
			cursor = 0;
			release = 1;
			releaseSum = 0;
			ringPrimed = false;
			worst = 1;
		},
	};
}
