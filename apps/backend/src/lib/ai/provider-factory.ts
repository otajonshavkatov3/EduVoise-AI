/**
 * Voice provider selection and health reporting.
 *
 * One decision, in one place: which VoiceProvider handles the next call.
 *
 *   AI_AGENT_ENABLED is not true                        -> fallback IVR
 *   AI_VOICE_PROVIDER=gemini and GOOGLE_AI_API_KEY set  -> Gemini Live
 *   OPENAI_API_KEY set                                  -> OpenAI Realtime
 *   anything else                                       -> fallback IVR
 *
 * WHICH provider is an environment decision; WHO the provider speaks as is not.
 * The business profile (voice, language, categories, knowledge) is passed in by
 * the orchestrator and handed straight to the Realtime provider, so the same
 * binary serves a dental clinic and a taxi firm without a redeploy.
 *
 * Note what resolveVoiceProvider() does NOT do by default: it does not probe
 * the API before returning the OpenAI provider. A probe costs a WebSocket
 * round trip to api.openai.com, and it would run while a caller is listening to
 * ringback. Instead the provider itself fails fast - `start()` throws
 * VoiceProviderUnavailableError - and the orchestrator falls back. Pass
 * `{ probe: true }` when the extra latency is acceptable (a warm-up on boot, a
 * health page) and the answer should be known before a call arrives.
 *
 * probeProviderHealth() is the deliberate, cached probe behind
 * /api/ai-assistant/status. It answers the question that matters operationally:
 * not "is a key configured" but "can this account actually open a session right
 * now".
 *
 * It reports on the provider that resolveVoiceProvider() would actually pick.
 * That sounds obvious, but it was not true: the probe always talked to OpenAI,
 * so a deployment running AI_VOICE_PROVIDER=gemini saw a status card naming
 * openai-realtime and an `available: true` measured against an API that was not
 * answering a single call. A health page that describes a different provider
 * than the one on the phone is worse than no health page.
 */
import pino from "pino";
import pretty from "pino-pretty";
import type { ActiveAgentProfile, KnowledgeHit } from "@/lib/ai-agent";
import type { VoiceProvider } from "@/lib/telephony/contracts";
import type { TenantId } from "@/lib/tenancy";
import { createFallbackIvrProvider, FALLBACK_IVR_PROVIDER_NAME } from "./fallback-ivr";
import {
	createGeminiLiveProvider,
	GEMINI_LIVE_PROVIDER_NAME,
	getGeminiLiveRuntime,
	isGeminiLiveConfigured,
} from "./gemini-live";
import {
	createOpenAiRealtimeProvider,
	OPENAI_REALTIME_PROVIDER_NAME,
	probeOpenAiRealtime,
} from "./openai-realtime";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "ai:provider-factory",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

const DEFAULT_MODEL = "gpt-realtime";
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_MODEL_CHECK_TIMEOUT_MS = 5_000;

/** Health is cached this long so a dashboard poll cannot hammer OpenAI. */
const DEFAULT_HEALTH_MAX_AGE_MS = 30_000;

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export interface VoiceProviderHealth {
	/** The provider that will serve the next call. */
	provider: string;
	/** Whether the OpenAI Realtime backend is genuinely usable by this account. */
	available: boolean;
	/** Human-readable explanation, safe to show in the dashboard. */
	detail: string;
}

export interface ResolveVoiceProviderOptions {
	/**
	 * Whose call this is. Required: the provider reads this tenant's stored voice,
	 * dialect and sampling settings, and resolving it here rather than inside the
	 * provider is what stopped every tenant silently falling back to the built-in
	 * defaults once the platform had two customers.
	 */
	tenantId: TenantId;
	/** Check the account before committing to the OpenAI provider. Default false. */
	probe?: boolean;
	/** How stale a cached probe result may be when `probe` is set. */
	probeMaxAgeMs?: number;
	/**
	 * The business this call is answered for.
	 *
	 * The orchestrator loads it once per call and passes it here, which is what
	 * makes the session speak with the configured voice, in the configured
	 * language, about the configured business. Omitted, the provider falls back to
	 * the environment - the pre-profile behaviour, kept so a deployment with no
	 * profile row still answers the phone.
	 */
	profile?: ActiveAgentProfile;
	/** Primed knowledge entries for that profile, quoted into the instructions. */
	knowledge?: readonly KnowledgeHit[];
}

export interface ProbeProviderHealthOptions {
	/** Accept a cached result younger than this. Default 30 s. */
	maxAgeMs?: number;
	/** Ignore the cache entirely. */
	force?: boolean;
	/** Realtime handshake budget. Default 8 s. */
	timeoutMs?: number;
}

interface CachedHealth {
	at: number;
	health: VoiceProviderHealth;
}

let cachedHealth: CachedHealth | null = null;
/** In-flight probe, so ten concurrent status requests make one connection. */
let inFlightProbe: Promise<VoiceProviderHealth> | null = null;

function isTruthy(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}

	const normalised = value.trim().toLowerCase();

	return normalised === "true" || normalised === "1" || normalised === "yes" || normalised === "on";
}

function readApiKey(): string {
	return (process.env.OPENAI_API_KEY ?? "").trim();
}

function readModel(): string {
	return process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_MODEL;
}

/**
 * Whether the deployment asked for Gemini Live.
 *
 * One reader for the environment flag, shared by the selector and the health
 * probe. They disagreeing is exactly the bug this exists to prevent.
 */
export function isGeminiVoiceSelected(): boolean {
	return (process.env.AI_VOICE_PROVIDER ?? "").trim().toLowerCase() === "gemini";
}

/**
 * The provider name resolveVoiceProvider() would return right now, without
 * building one or touching the network.
 *
 * Used by the config endpoint so the dashboard offers the right voice list and
 * the right model, and by the probe so it talks to the right vendor.
 */
export function selectedVoiceProviderName(): string {
	if (!isTruthy(process.env.AI_AGENT_ENABLED)) {
		return FALLBACK_IVR_PROVIDER_NAME;
	}

	if (isGeminiVoiceSelected()) {
		return isGeminiLiveConfigured() ? GEMINI_LIVE_PROVIDER_NAME : FALLBACK_IVR_PROVIDER_NAME;
	}

	return readApiKey().length > 0 ? OPENAI_REALTIME_PROVIDER_NAME : FALLBACK_IVR_PROVIDER_NAME;
}

/**
 * Choose the provider for the next call.
 *
 * Async because probing is optional but real; without `probe` it resolves
 * immediately.
 */
export async function resolveVoiceProvider(
	options: ResolveVoiceProviderOptions
): Promise<VoiceProvider> {
	const enabled = isTruthy(process.env.AI_AGENT_ENABLED);
	const apiKey = readApiKey();

	if (!enabled) {
		logger.info("AI_AGENT_ENABLED is not true: using the fallback IVR provider");
		return createFallbackIvrProvider();
	}

	/**
	 * Gemini Live, when the deployment asks for it.
	 *
	 * Checked before the OpenAI key, because a business that switched provider has
	 * no reason to keep an OpenAI key around, and the absence of one must not push
	 * a working Gemini deployment onto the IVR fallback. Set
	 * AI_VOICE_PROVIDER=gemini to switch, and remove the line to switch back - the
	 * two providers satisfy the same contract, so nothing else changes.
	 */
	if (isGeminiVoiceSelected()) {
		if (!isGeminiLiveConfigured()) {
			logger.warn(
				"AI_VOICE_PROVIDER=gemini but GOOGLE_AI_API_KEY is not set: using the fallback IVR provider"
			);
			return createFallbackIvrProvider();
		}

		logger.info(
			{ business: options.profile?.businessName, knowledgeEntries: options.knowledge?.length ?? 0 },
			"building a Gemini Live provider for the configured business"
		);

		return createGeminiLiveProvider({
			tenantId: options.tenantId,
			agentProfile: options.profile,
			knowledge: options.knowledge,
			voice: options.profile?.voice,
		});
	}

	if (apiKey.length === 0) {
		logger.warn("OPENAI_API_KEY is not set: using the fallback IVR provider");
		return createFallbackIvrProvider();
	}

	if (options.probe === true) {
		const health = await probeProviderHealth({ maxAgeMs: options.probeMaxAgeMs });

		if (!health.available) {
			logger.warn(
				{ detail: health.detail },
				"the OpenAI Realtime API is not available: using the fallback IVR provider"
			);
			return createFallbackIvrProvider();
		}
	}

	const profile = options.profile;

	if (profile !== undefined) {
		logger.debug(
			{
				business: profile.businessName,
				configured: profile.isConfigured,
				voice: profile.voice,
				language: profile.language,
				knowledgeEntries: options.knowledge?.length ?? 0,
			},
			"building a Realtime provider for the configured business"
		);
	}

	return createOpenAiRealtimeProvider({
		// `undefined` for either keeps the provider's own environment defaults, so
		// the no-profile path is byte-for-byte the session it always sent.
		agentProfile: profile,
		knowledge: options.knowledge,
	});
}

/**
 * Ask OpenAI's REST API what it thinks of the configured model.
 *
 * Used only to explain a failed Realtime probe. A 404 with
 * `model_not_found` means the account has no access to the realtime model,
 * which is a different (and much more actionable) message than "the socket
 * closed".
 */
async function describeModelAccess(apiKey: string, model: string): Promise<string | null> {
	try {
		const response = await fetch(`${OPENAI_MODELS_URL}/${encodeURIComponent(model)}`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(DEFAULT_MODEL_CHECK_TIMEOUT_MS),
		});

		if (response.ok) {
			return `model ${model} is visible to this API key, but no Realtime session could be opened with it`;
		}

		const body = await response.text().catch(() => "");
		let message = body.slice(0, 300);

		try {
			const parsed: unknown = JSON.parse(body);

			if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
				const { error } = parsed as { error?: { message?: string; code?: string | null } };
				// OpenAI sends `"code": null` as often as it omits it.
				const code =
					typeof error?.code === "string" && error.code.length > 0 ? ` (${error.code})` : "";
				message = `${error?.message ?? message}${code}`;
			}
		} catch {
			// Not JSON - the truncated body above is the best available detail.
		}

		return `GET /v1/models/${model} returned HTTP ${response.status}: ${message}`;
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);

		return `the model check for ${model} could not be completed: ${reason}`;
	}
}

/**
 * Join fragments into one sentence-per-fact string. Each fragment arrives with
 * or without its own full stop (OpenAI's messages usually have one), so they are
 * normalised rather than concatenated into "it.. GET /v1/models".
 */
function joinSentences(...parts: Array<string | null>): string {
	const sentences = parts
		.filter((part): part is string => part !== null && part.trim().length > 0)
		.map((part) => part.trim().replace(/\.+$/, ""));

	return sentences.length === 0 ? "" : `${sentences.join(". ")}.`;
}

/**
 * Ask Gemini's REST API whether this key can see the Live model.
 *
 * Deliberately not a WebSocket handshake. Opening a BidiGenerateContent session
 * just to close it starts a billable session and tells us little more than this
 * does: the two ways a Gemini deployment fails in practice are a bad key and a
 * model the project cannot see, and both show up here. The detail says plainly
 * that no live session was negotiated, so nobody reads more into it than it
 * measures.
 */
async function runGeminiProbe(): Promise<VoiceProviderHealth> {
	const { apiKey, model } = getGeminiLiveRuntime();

	try {
		const response = await fetch(`${GEMINI_MODELS_URL}/${encodeURIComponent(model)}`, {
			headers: { "x-goog-api-key": apiKey },
			signal: AbortSignal.timeout(DEFAULT_MODEL_CHECK_TIMEOUT_MS),
		});

		if (response.ok) {
			return {
				provider: GEMINI_LIVE_PROVIDER_NAME,
				available: true,
				detail: `model ${model} is visible to this Google AI key (no live session was opened - the handshake happens on the first call)`,
			};
		}

		const body = (await response.text().catch(() => "")).slice(0, 300);

		return {
			provider: FALLBACK_IVR_PROVIDER_NAME,
			available: false,
			detail: joinSentences(
				`GET /v1beta/models/${model} returned HTTP ${response.status}: ${body}`,
				"Calls are handled by the IVR fallback and transferred to an operator"
			),
		};
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);

		return {
			provider: FALLBACK_IVR_PROVIDER_NAME,
			available: false,
			detail: joinSentences(
				`the Gemini model check for ${model} could not be completed: ${reason}`,
				"Calls are handled by the IVR fallback and transferred to an operator"
			),
		};
	}
}

async function runProbe(timeoutMs: number): Promise<VoiceProviderHealth> {
	if (isGeminiVoiceSelected()) {
		return await runGeminiProbe();
	}

	const apiKey = readApiKey();
	const model = readModel();
	const probe = await probeOpenAiRealtime({ apiKey, model, timeoutMs });

	if (probe.ok) {
		return {
			provider: OPENAI_REALTIME_PROVIDER_NAME,
			available: true,
			detail: probe.detail,
		};
	}

	const explanation = await describeModelAccess(apiKey, model);

	return {
		// The realtime session cannot be opened, so calls will be served by the
		// fallback - that is what an operator needs to see on the status page.
		provider: FALLBACK_IVR_PROVIDER_NAME,
		available: false,
		detail: joinSentences(
			probe.detail,
			explanation,
			"Calls are handled by the IVR fallback and transferred to an operator"
		),
	};
}

/**
 * Report whether the configured voice backend actually works.
 *
 * Results are cached (and concurrent callers share one probe) because this is
 * wired to an HTTP endpoint a dashboard polls.
 */
export async function probeProviderHealth(
	options: ProbeProviderHealthOptions = {}
): Promise<VoiceProviderHealth> {
	if (!isTruthy(process.env.AI_AGENT_ENABLED)) {
		return {
			provider: FALLBACK_IVR_PROVIDER_NAME,
			available: false,
			detail: "AI_AGENT_ENABLED is not true, so the AI agent is switched off by configuration",
		};
	}

	if (isGeminiVoiceSelected()) {
		if (!isGeminiLiveConfigured()) {
			return {
				provider: FALLBACK_IVR_PROVIDER_NAME,
				available: false,
				detail:
					"AI_VOICE_PROVIDER=gemini but GOOGLE_AI_API_KEY is not set, so no Gemini Live session can be opened",
			};
		}
	} else if (readApiKey().length === 0) {
		return {
			provider: FALLBACK_IVR_PROVIDER_NAME,
			available: false,
			detail: "OPENAI_API_KEY is not set, so no Realtime session can be opened",
		};
	}

	const maxAgeMs = options.maxAgeMs ?? DEFAULT_HEALTH_MAX_AGE_MS;

	if (options.force !== true && cachedHealth !== null && Date.now() - cachedHealth.at < maxAgeMs) {
		return cachedHealth.health;
	}

	if (inFlightProbe !== null) {
		return await inFlightProbe;
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const pending = runProbe(timeoutMs)
		.then((health) => {
			cachedHealth = { at: Date.now(), health };
			logger.info({ ...health }, "voice provider health probed");
			return health;
		})
		.catch((cause: unknown) => {
			const reason = cause instanceof Error ? cause.message : String(cause);
			const health: VoiceProviderHealth = {
				provider: FALLBACK_IVR_PROVIDER_NAME,
				available: false,
				detail: `the Realtime health probe failed: ${reason}`,
			};

			cachedHealth = { at: Date.now(), health };
			logger.error({ err: cause }, "voice provider health probe threw");
			return health;
		})
		.finally(() => {
			inFlightProbe = null;
		});

	inFlightProbe = pending;

	return await pending;
}

/** Drop the cached health result (used after the environment changes). */
export function resetVoiceProviderHealthCache(): void {
	cachedHealth = null;
}
