/**
 * Loads the editable rate table out of the settings registry.
 *
 * Split from price.ts so the arithmetic stays pure and unit-testable with a
 * literal rate table, while this file owns the one impure concern: which rates
 * the owner has actually entered.
 */
import type { TenantId } from "@shared/types";

import { listSettings, type SettingKey } from "@/lib/settings";

import type { RateTable } from "./price";

/** Every pricing key, in the order the Settings tab shows them. */
export const PRICING_KEYS = [
	"pricing.usdToUzs",
	"pricing.openaiRealtime.textInputPer1M",
	"pricing.openaiRealtime.textInputCachedPer1M",
	"pricing.openaiRealtime.audioInputPer1M",
	"pricing.openaiRealtime.audioInputCachedPer1M",
	"pricing.openaiRealtime.textOutputPer1M",
	"pricing.openaiRealtime.audioOutputPer1M",
	"pricing.geminiLive.textInputPer1M",
	"pricing.geminiLive.textInputCachedPer1M",
	"pricing.geminiLive.audioInputPer1M",
	"pricing.geminiLive.audioInputCachedPer1M",
	"pricing.geminiLive.textOutputPer1M",
	"pricing.geminiLive.audioOutputPer1M",
	"pricing.transcribe.audioInputPer1M",
	"pricing.transcribe.textOutputPer1M",
	"pricing.analysis.inputPer1M",
	"pricing.analysis.cachedInputPer1M",
	"pricing.analysis.outputPer1M",
] as const satisfies readonly SettingKey[];

export type PricingKey = (typeof PRICING_KEYS)[number];

export interface LoadedRates {
	rates: RateTable;
	/**
	 * Keys still sitting on the registry default, i.e. never reviewed by anyone
	 * here. The defaults are published list prices, which makes them a plausible
	 * guess about another company's pricing page on some past day - not a fact
	 * about this account's bill. The page says so while this list is non-empty.
	 */
	unreviewedKeys: PricingKey[];
	/** Keys explicitly set to 0, which switches that line off rather than making it free. */
	zeroKeys: PricingKey[];
	/** When the owner last touched any rate. Null while every rate is a default. */
	lastReviewedAt: string | null;
}

function numberAt(values: Map<string, number>, key: PricingKey): number {
	return values.get(key) ?? 0;
}

/**
 * Read every pricing setting in one query, plus whether each is stored or still
 * the shipped default.
 */
export async function loadRates(tenantId: TenantId): Promise<LoadedRates> {
	const snapshot = await listSettings(tenantId, "pricing");
	const values = new Map<string, number>();
	const unreviewedKeys: PricingKey[] = [];
	const zeroKeys: PricingKey[] = [];
	let lastReviewedAt: Date | null = null;

	for (const item of snapshot) {
		const value = typeof item.value === "number" ? item.value : 0;

		values.set(item.key, value);

		if (!item.isStored) {
			unreviewedKeys.push(item.key as PricingKey);
		} else if (
			item.updatedAt !== null &&
			(lastReviewedAt === null || item.updatedAt > lastReviewedAt)
		) {
			lastReviewedAt = item.updatedAt;
		}

		// The exchange rate is not a token rate: 0 there means "dollars only",
		// which is a deliberate choice rather than an unpriced line.
		if (value === 0 && item.key !== "pricing.usdToUzs") {
			zeroKeys.push(item.key as PricingKey);
		}
	}

	const rates: RateTable = {
		usdToUzs: numberAt(values, "pricing.usdToUzs"),
		openaiRealtime: {
			textInputPer1M: numberAt(values, "pricing.openaiRealtime.textInputPer1M"),
			textInputCachedPer1M: numberAt(values, "pricing.openaiRealtime.textInputCachedPer1M"),
			audioInputPer1M: numberAt(values, "pricing.openaiRealtime.audioInputPer1M"),
			audioInputCachedPer1M: numberAt(values, "pricing.openaiRealtime.audioInputCachedPer1M"),
			textOutputPer1M: numberAt(values, "pricing.openaiRealtime.textOutputPer1M"),
			audioOutputPer1M: numberAt(values, "pricing.openaiRealtime.audioOutputPer1M"),
		},
		geminiLive: {
			textInputPer1M: numberAt(values, "pricing.geminiLive.textInputPer1M"),
			textInputCachedPer1M: numberAt(values, "pricing.geminiLive.textInputCachedPer1M"),
			audioInputPer1M: numberAt(values, "pricing.geminiLive.audioInputPer1M"),
			audioInputCachedPer1M: numberAt(values, "pricing.geminiLive.audioInputCachedPer1M"),
			textOutputPer1M: numberAt(values, "pricing.geminiLive.textOutputPer1M"),
			audioOutputPer1M: numberAt(values, "pricing.geminiLive.audioOutputPer1M"),
		},
		transcribe: {
			audioInputPer1M: numberAt(values, "pricing.transcribe.audioInputPer1M"),
			textOutputPer1M: numberAt(values, "pricing.transcribe.textOutputPer1M"),
		},
		analysis: {
			inputPer1M: numberAt(values, "pricing.analysis.inputPer1M"),
			cachedInputPer1M: numberAt(values, "pricing.analysis.cachedInputPer1M"),
			outputPer1M: numberAt(values, "pricing.analysis.outputPer1M"),
		},
	};

	return {
		rates,
		unreviewedKeys,
		zeroKeys,
		lastReviewedAt: lastReviewedAt === null ? null : lastReviewedAt.toISOString(),
	};
}
