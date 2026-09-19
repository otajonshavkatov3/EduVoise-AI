// biome-ignore-all lint/style/useNamingConvention: two wire vocabularies appear verbatim in this file - the Asterisk channel variables the dialplan reads (AS_UUID, AS_HOST) and the OpenAI chat-completions body fields (response_format, max_tokens, Content-Type). Renaming either would break the integration.
/**
 * Call orchestrator - the state machine that turns a phone call into CRM rows.
 *
 * One inbound call touches four systems, and this module is the only place that
 * knows the order they have to be touched in:
 *
 *   Asterisk (ARI)   answer the channel, set AS_UUID / AS_HOST, hand the channel
 *                    to [ai-bridge], play prompts, bridge a transfer.
 *   AudioSocket      the 8 kHz audio path, correlated to the CRM record by
 *                    `calls.id` being the AudioSocket UUID.
 *   Voice provider   speech to speech, or the IVR fallback when no realtime
 *                    model is reachable.
 *   Postgres         contacts, calls, ai_sessions, call_transcripts, tickets,
 *                    notes, follow-ups, bookings, recordings, ai_analyses.
 *
 * Three rules shape everything below.
 *
 *   1. The caller never gets dead air. A provider that cannot start, a tool that
 *      throws, an operator who does not answer - each has a path that still ends
 *      with the caller hearing something or reaching a human.
 *   2. Every teardown path is idempotent. StasisEnd, ChannelDestroyed, the
 *      AudioSocket closing and a hangup we asked for ourselves all race, and all
 *      four can arrive for the same call. Guards live on the in-memory call
 *      record AND in the SQL (`ended_at IS NULL`), so running a teardown twice
 *      changes nothing.
 *   3. Nothing here is on the legacy FreePBX path. routes/webhooks keeps writing
 *      its own `calls` rows through its own handlers, untouched.
 *
 * The channel is deliberately kept in Stasis on the fallback path: ARI can only
 * play prompts, start MoH and build bridges for a channel it owns, and the
 * fallback needs all three. The realtime path is the opposite - it hands the
 * channel to [ai-bridge] so MixMonitor and AudioSocket can run.
 */
import type { Buffer } from "node:buffer";
import { getServerEnv } from "@shared/env";
import pino from "pino";
import pretty from "pino-pretty";
import { z } from "zod/v4";
import type {
	AddNoteArgs,
	AudioSocketSession,
	BookAppointmentArgs,
	CreateFollowUpArgs,
	CreateTicketArgs,
	EndCallArgs,
	RecordCallOutcomeArgs,
	RenderedSpeech,
	SaveContactDetailsArgs,
	SearchKnowledgeBaseArgs,
	TransferToHumanArgs,
} from "@/lib/ai";
import {
	AudioSocketServer,
	buildGreeting,
	buildKnowledgeMissGuidance,
	CallerVoiceActivity,
	createFallbackIvrProvider,
	FALLBACK_IVR_PROVIDER_NAME,
	FALLBACK_TICKET_CATEGORIES,
	FALLBACK_TRANSFER_REASON,
	isElevenLabsConfigured,
	muLawDecode,
	normaliseTicketCategories,
	renderCached,
	resolveTicketCategory,
	resolveVoiceProvider,
	unconfiguredAgentProfile,
	validateToolArguments,
} from "@/lib/ai";
import type { ActiveAgentProfile, KnowledgeHit } from "@/lib/ai-agent";
import { getActiveAgentProfile, getPrimedEntries, searchKnowledgeBase } from "@/lib/ai-agent";
import {
	AriEventStream,
	AriRequestError,
	ensureTenantRecordingDir,
	getAmiClient,
	getAriClient,
	tenantContextsFor,
} from "@/lib/asterisk";
import { type AiRuntimeConfig, getAiRuntimeConfig, refreshAiRuntimeConfig } from "@/lib/settings";
import { getSoleTenantId, getTenantById, type TenantId } from "@/lib/tenancy";
import { broadcastCallEvent } from "@/lib/ws/registry";
import type { ContactAddress, ContactMatch } from "./contact-matcher";
import { findOrCreateContact, getContactHistory } from "./contact-matcher";
import type {
	AriClient,
	AriEventOf,
	AsteriskChannel,
	OutboundCallPurpose,
	TranscriptRole,
	VoiceProvider,
	VoiceProviderHandlers,
	VoiceSessionContext,
} from "./contracts";
import { VoiceProviderUnavailableError } from "./contracts";
import type {
	CallStatus,
	CreateInboundCallResult,
	Sentiment,
	TranscriptTextResult,
} from "./crm-writer";
import {
	addNote,
	appendTranscript,
	buildTranscriptText,
	createAiSession,
	createBooking,
	createFollowUp,
	createInboundCall,
	createTicketFromCall,
	finishAiSession,
	markCallAnswered,
	markCallEnded,
	resolveOperatorByExtension,
	saveRecording,
	setCallContact,
	updateAiSession,
	upsertContactDetails,
	writeAiAnalysis,
} from "./crm-writer";
import { resolveInboundTenant } from "./inbound-tenant";
import type { OutboundCallRequest, OutboundOutcome, PlaceOutboundCallResult } from "./outbound";
import {
	classifyHangupCause,
	describeOutboundDialing,
	isDoNotCallNumber,
	reportOutboundOptOut,
	reportOutboundOutcome,
	resolveOutboundEndpoint,
} from "./outbound";
import { transferToHuman } from "./transfer";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "telephony:orchestrator",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

// ===========================================
// Constants
// ===========================================

/**
 * Where the bridge context starts: MixMonitor, then AudioSocket(AS_UUID, AS_HOST).
 *
 * The context itself is per tenant - `ai-bridge-avilab` - and is resolved per call
 * by tenantContextsFor(), because a caller must never execute dialplan that can
 * see another customer's endpoints. Only the extension inside it is constant.
 */
const BRIDGE_EXTENSION = "s";

/** Stasis argument transfer.ts puts on the operator leg it originates. */
const TRANSFER_LEG_ARG = "transfer";

/**
 * Stasis argument placeOutboundCall() puts on a campaign leg it originates.
 *
 * The channel we ring enters the SAME Stasis application an inbound caller
 * enters, which is the entire trick that lets one orchestrator serve both
 * directions. This marker plus the call id in args[1] is how handleStasisStart
 * tells "somebody rang us" apart from "the person we rang has picked up" -
 * without it, an answered campaign call would be read as a brand-new inbound
 * call and get a second `calls` row.
 */
const OUTBOUND_LEG_ARG = "outbound";

/**
 * How long after ARI accepts the dial we still expect either an answer or a
 * hangup event, on top of the ring timeout.
 *
 * A safety net, not the mechanism: ChannelDestroyed ends a no-answer dial
 * promptly and StasisStart ends an answered one. This exists because a dial that
 * produces NEITHER event - Asterisk restarted, the event socket dropped and
 * reconnected past it - would otherwise leave a `calls` row stuck at "ringing"
 * for ever and hold a slot in the dialer's concurrency budget with it.
 */
const OUTBOUND_DIAL_GRACE_MS = 20_000;

/**
 * Asterisk's own prompts, used on the fallback path where no model produces
 * audio. All three ship with asterisk-core-sounds-en, which the container has.
 */
const FALLBACK_PROMPT_MEDIA = "sound:one-moment-please";
const GOODBYE_MEDIA = "sound:vm-goodbye";
const TROUBLE_MEDIA = "sound:technical-difficulties";

/** Give up waiting for PlaybackFinished after this long and carry on. */
const PLAYBACK_MAX_WAIT_MS = 15_000;

/** Interim transcript deltas: broadcast this often, persist this often. */
const INTERIM_BROADCAST_MIN_INTERVAL_MS = 250;
const INTERIM_WRITE_MIN_INTERVAL_MS = 2_000;
/** An interim buffer never grows past this; the final row carries the real text. */
const INTERIM_MAX_CHARS = 4_000;

/**
 * Ceiling on how long a goodbye may take before the channel is cut anyway.
 *
 * Generous on purpose: the wait ends as soon as the audio has actually drained,
 * so this only bounds a model that never stops talking. It used to be a flat
 * sleep, which cut the farewell off mid-word - measured as 112 frames (2.2 s) of
 * speech still queued when the session closed.
 */
const SPOKEN_GOODBYE_MAX_WAIT_MS = 15_000;
/** Same, for the model's own end_call tool. */
const END_CALL_MAX_WAIT_MS = 15_000;
/**
 * Ceiling on the "I am connecting you to an operator" line.
 *
 * Shorter than the goodbye budget on purpose: the caller is waiting to be put
 * through, so a model that rambles must not delay the transfer for long.
 */
const TRANSFER_ANNOUNCE_MAX_WAIT_MS = 6_000;
/** How often the drain wait re-checks while the model's audio is still arriving. */
const AGENT_AUDIO_POLL_MS = 100;
/**
 * How long to wait for the first audio of a goodbye before giving up on it.
 *
 * `say()` only asks the model to speak. If nothing is queued by now the model is
 * not going to answer, and the caller should not be held on a dead line.
 */
const AGENT_AUDIO_START_WAIT_MS = 3_000;
/**
 * Slack for Asterisk's own playout buffer once our queue is empty.
 *
 * An empty queue means the last frame reached Asterisk, not that the caller has
 * heard it: the channel still has a jitter buffer and an RTP hop to go.
 */
const AGENT_AUDIO_PLAYOUT_MARGIN_MS = 400;

/**
 * If ChannelDestroyed never arrives (ARI event stream down, Asterisk restarted),
 * finalise the call row anyway rather than leaving it open forever.
 */
const FINALIZE_SAFETY_MS = 10_000;

/**
 * How many times the platform speaks its own "say that again" line to a caller
 * whose agent has stopped answering.
 *
 * Two, because a line the caller has already heard twice adds nothing the third
 * time; from then on the stall is only logged. The call itself keeps running -
 * see `handleAgentStall`.
 */
const MAX_AGENT_STALL_RECOVERIES = 2;

/**
 * How many `system` transcript rows one stalled agent may write.
 *
 * The row is the honest record of a fault, and the owner needs to see it on the
 * call - but a five-minute call could otherwise accumulate a dozen identical
 * lines, which is noise rather than evidence.
 */
const MAX_AGENT_STALL_NOTES = 3;

/**
 * Ceiling on the stall-recovery line.
 *
 * Shorter than the goodbye budget: the caller is mid-conversation and waiting,
 * so this must not become a pause of its own.
 */
const STALL_RECOVERY_MAX_WAIT_MS = 6_000;

/**
 * How many unanswered windows an ENERGY signal alone may hold a call open.
 *
 * The detector rejects steady noise, but a line whose noise swells and fades -
 * measured live at +/-9 dB around 0.1 Hz on a line with nobody on it - crosses
 * the over-noise ratio on every swell and reads as somebody talking. Left
 * unbounded that holds an empty call up until max-duration and writes "the caller
 * is talking" notes about nobody.
 *
 * So energy gets a limit, and the model is the second opinion: a real caller
 * produces transcripts, and the model is a far better speech detector than an RMS
 * gate. Once this many windows have passed with the agent answering nothing AND
 * the provider never once transcribing the caller, the energy is not believed and
 * the silence guard is allowed to do its job. A call with even one caller
 * transcript is never ended this way - somebody demonstrably said something.
 */
const MAX_UNCORROBORATED_STALLS = 3;

/**
 * How long the caller must have been quiet before the agent counts as stalled.
 *
 * The stall guard exists to catch a model that has gone deaf, and the one thing
 * that looks exactly like it is a model listening properly to somebody who has not
 * finished talking. Four seconds settles that: a Gemini Live reply begins 1-3 s
 * after the caller stops, so four seconds of caller silence with nothing back is
 * outside normal latency, and a caller still mid-sentence is never inside it.
 */
const AGENT_STALL_TURN_GAP_MS = 4_000;

/**
 * At most one caller-speech notification per half second.
 *
 * A talking caller produces 50 voiced frames a second and each notification only
 * pushes back timers measured in tens of seconds, so telling the guards fifty
 * times a second would be fifty times the work for exactly the same effect.
 */
const CALLER_SPEECH_NOTIFY_INTERVAL_MS = 500;

/** How many knowledge entries are primed into the prompt, and how many a lookup returns. */
const PRIMED_KNOWLEDGE_LIMIT = 12;
const KNOWLEDGE_SEARCH_LIMIT = 4;

/** Post-call summary: model, budget and how much transcript is sent. */
const ANALYSIS_URL = "https://api.openai.com/v1/chat/completions";
const ANALYSIS_TIMEOUT_MS = 20_000;
const ANALYSIS_MAX_TRANSCRIPT_CHARS = 12_000;
const ANALYSIS_MAX_TOKENS = 600;

// ===========================================
// Public types
// ===========================================

export const LIVE_CALL_EVENTS = {
	started: "live_call_started",
	updated: "live_call_updated",
	transcript: "live_call_transcript",
	transfer: "live_call_transfer",
	ended: "live_call_ended",
	analysis: "live_call_analysis",
} as const;

export type LiveCallEventType = (typeof LIVE_CALL_EVENTS)[keyof typeof LIVE_CALL_EVENTS];

/** Where a live call is in the AI flow. */
export type LiveCallStatus =
	| "starting"
	| "live"
	| "transferring"
	| "transferred"
	| "ending"
	| "ended";

export interface LiveCallContact {
	id: string;
	firstName: string | null;
	lastName: string | null;
	/** Same convention as the legacy webhook payload: joined name, or null. */
	contactName: string | null;
	address: ContactAddress | null;
}

/** What the dashboard needs to render one row of the live-call board. */
export interface LiveCallSnapshot {
	callId: string;
	/**
	 * Whose call this is.
	 *
	 * On the snapshot, not just on the private ActiveCall, because the live-call board
	 * reads from MEMORY rather than from the database: without it the HTTP layer has
	 * nothing to filter by and every supervisor on the platform would see every
	 * customer's live calls - caller numbers, contact names and all. This is the one
	 * place in the whole read path where the tenant cannot come from a WHERE clause.
	 */
	tenantId: TenantId;
	channelId: string;
	callerNumber: string;
	direction: "inbound" | "outbound";
	status: LiveCallStatus;
	provider: string | null;
	aiSessionId: string | null;
	contact: LiveCallContact | null;
	isReturningCaller: boolean;
	previousCallCount: number;
	ticketId: string | null;
	transferExtension: string | null;
	transferStatus: TransferPhase;
	startedAt: string;
	durationSeconds: number;
}

export type TransferPhase = "none" | "requested" | "connected" | "failed";

export interface LiveCallStartedEvent {
	type: typeof LIVE_CALL_EVENTS.started;
	call: LiveCallSnapshot;
}

export interface LiveCallUpdatedEvent {
	type: typeof LIVE_CALL_EVENTS.updated;
	call: LiveCallSnapshot;
}

export interface LiveCallTranscriptEvent {
	type: typeof LIVE_CALL_EVENTS.transcript;
	callId: string;
	role: TranscriptRole;
	content: string;
	isFinal: boolean;
	startMs: number | null;
	endMs: number | null;
	at: string;
}

export interface LiveCallTransferEvent {
	type: typeof LIVE_CALL_EVENTS.transfer;
	callId: string;
	phase: TransferPhase;
	extension: string | null;
	reason: string | null;
	failureReason: string | null;
	call: LiveCallSnapshot;
}

export interface LiveCallEndedEvent {
	type: typeof LIVE_CALL_EVENTS.ended;
	callId: string;
	status: CallStatus;
	durationSeconds: number;
	ticketId: string | null;
	transferExtension: string | null;
	endReason: string | null;
}

export interface LiveCallAnalysisEvent {
	type: typeof LIVE_CALL_EVENTS.analysis;
	callId: string;
	aiStatus: "completed" | "failed";
	summary: string | null;
}

export type LiveCallEvent =
	| LiveCallStartedEvent
	| LiveCallUpdatedEvent
	| LiveCallTranscriptEvent
	| LiveCallTransferEvent
	| LiveCallEndedEvent
	| LiveCallAnalysisEvent;

/** Input for the post-call summariser. */
export interface CallSummaryInput {
	callId: string;
	/** Whose call this is. Selects the analysis model this customer is configured with. */
	tenantId: TenantId;
	transcript: string;
	language: string;
	/** The business the call was answered for, when a profile is configured. */
	businessName?: string;
	/** The business's own ticket categories, so the summary is labelled in its words. */
	categories?: readonly string[];
}

/** What one summariser run cost. Optional: an injected summariser need not know. */
export interface CallSummaryUsage {
	model: string;
	promptTokens: number;
	cachedPromptTokens: number;
	completionTokens: number;
}

/** What the summariser has to produce for writeAiAnalysis. */
export interface CallSummary {
	summary: string;
	sentiment: Sentiment;
	categories: string[];
	confidence: number | null;
	/**
	 * Optional so every injected test summariser and the public CallSummariser
	 * type stay source-compatible. Absent means "this run's cost is unknown",
	 * which the cost page must show as unknown rather than as zero.
	 */
	usage?: CallSummaryUsage;
}

/**
 * A summariser throws on failure rather than returning null: the thrown message
 * is what lands in `ai_analyses.error_message`, and a call whose summary could
 * not be produced must be visible as failed rather than silently empty.
 */
export type CallSummariser = (input: CallSummaryInput) => Promise<CallSummary>;

/**
 * What the provider factory is told about the business before it builds a session.
 *
 * The orchestrator resolves the profile and its primed knowledge once per call and
 * hands both over here, so the provider can configure the voice, the language, the
 * advertised categories and the instructions from one consistent snapshot.
 */
export interface VoiceProviderSetup {
	/**
	 * Whose call this is.
	 *
	 * Carried here rather than resolved inside the provider: the provider reads this
	 * tenant's stored voice, dialect and sampling settings, and the version that
	 * resolved "the sole tenant" instead silently fell back to the built-in defaults
	 * for EVERY customer once the platform had two.
	 */
	tenantId: TenantId;
	profile: ActiveAgentProfile;
	knowledge: readonly KnowledgeHit[];
}

export interface CallOrchestratorOptions {
	ari?: AriClient;
	events?: AriEventStream;
	audioSocket?: AudioSocketServer;
	/**
	 * One provider instance per call - providers are single-use.
	 *
	 * A factory that ignores the setup argument is still valid (that is what every
	 * existing test passes), so this stayed source-compatible.
	 */
	providerFactory?: (setup: VoiceProviderSetup) => Promise<VoiceProvider>;
	/** Overridable so the lead can swap in a richer post-call pipeline. */
	summarise?: CallSummariser;
	/**
	 * Pause between session-ready and the greeting.
	 *
	 * Omitted, the configured value (ai.greetingDelayMs, defaulting to
	 * AI_AGENT_GREETING_DELAY_MS) is read per call. Passing it here pins it, which
	 * is what a test that must not depend on the database wants.
	 */
	greetingDelayMs?: number;
}

export interface TransferOutcome {
	connected: boolean;
	extension: string | null;
	transferId: string | null;
	failureReason: string | null;
	/** False when the dialplan now owns the caller, so the agent must go quiet. */
	callerRetained: boolean;
	/** True when a transfer was already in flight and this request was a no-op. */
	alreadyInProgress: boolean;
}

// ===========================================
// Internal state
// ===========================================

interface InterimTranscript {
	text: string;
	startMs: number | null;
	lastWriteAt: number;
	lastBroadcastAt: number;
}

interface TransferRecord {
	phase: TransferPhase;
	extension: string | null;
	transferId: string | null;
	/** The operator's channel, so we notice when they leave the bridge. */
	toChannelId: string | null;
	reason: string | null;
	failureReason: string | null;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * A dial ARI has accepted, whose channel has not entered Stasis yet.
 *
 * It lives outside `calls`/`callsByChannel` on purpose: those two maps mean "a
 * conversation is under way", and a ringing phone is not one. Everything the
 * answered call will need is parked here so that StasisStart can promote it in
 * one step, and so a hangup before the answer still has the campaign identifiers
 * it needs to report a no-answer to the right lead.
 */
interface PendingOutboundDial {
	callId: string;
	/** From the `calls` row written at dial time, so the answered call inherits it. */
	tenantId: TenantId;
	channelId: string;
	/** Digits, as written to calls.caller_number. */
	phone: string;
	endpoint: string;
	campaign: OutboundCallPurpose;
	campaignId: string | null;
	leadId: string | null;
	requestedByUserId: string | null;
	contact: LiveCallContact | null;
	startedAt: Date;
	startedAtMs: number;
	/** Fires only if neither StasisStart nor ChannelDestroyed ever arrives. */
	graceTimer: TimerHandle | null;
	/** Guard: answered, abandoned and the watchdog all race to settle one dial. */
	settled: boolean;
}

/**
 * What the campaign side is owed about a call that had a conversation on it.
 *
 * Carried on the ActiveCall rather than written straight through, because two
 * different things have to happen with one decision: the outcome is reported the
 * instant the agent records it (a person who hangs up mid-sentence must not lose
 * their opt-out), and finalizeCall then has to know NOT to report a second,
 * duller outcome over the top of it.
 */
interface OutboundCallState {
	campaign: OutboundCallPurpose;
	campaignId: string | null;
	leadId: string | null;
	requestedByUserId: string | null;
	/** Set once record_call_outcome has been accepted and reported. */
	reportedOutcome: OutboundOutcome | null;
}

interface ActiveCall {
	callId: string;
	/**
	 * The customer this call belongs to, decided once when the `calls` row was
	 * created and carried for the length of the call.
	 *
	 * Every per-call configuration read goes through it - the voice, the dialect,
	 * the limits, the language - so two concurrent calls for two customers cannot
	 * read each other's settings. Before tenancy these reads came from a single
	 * process-wide snapshot, which is exactly what would have leaked.
	 */
	tenantId: TenantId;
	/**
	 * The same customer, spelled the way ASTERISK knows them.
	 *
	 * Every context and endpoint name this call touches is derived from it -
	 * `ai-bridge-avilab`, `PJSIP/avilab-101`, the recording directory - so it is
	 * resolved once with the tenant and carried, rather than looked up again in the
	 * middle of a transfer where a failed lookup would silently fall back to a
	 * SHARED context. Null only when the tenant row cannot be read at all, which
	 * keeps every consumer on the pre-tenancy names instead of on a guess.
	 */
	tenantSlug: string | null;
	channelId: string;
	channelName: string;
	callerNumber: string;
	dialledExtension: string | null;
	direction: "inbound" | "outbound";
	/**
	 * Set only on a call the platform placed as part of a campaign.
	 *
	 * Null on every inbound call, which is what keeps the prompt, the tool list and
	 * the teardown on exactly the paths they were on before campaigns existed.
	 */
	outbound: OutboundCallState | null;
	startedAt: Date;
	startedAtMs: number;

	contact: LiveCallContact | null;
	previousCallCount: number;
	isReturningCaller: boolean;
	ticketId: string | null;

	aiSessionId: string | null;
	provider: VoiceProvider | null;
	providerName: string | null;
	context: VoiceSessionContext | null;
	session: AudioSocketSession | null;

	/**
	 * The business this call is answered for, resolved once when the provider is
	 * launched. Null only for the brief window before that, and on a call that
	 * failed during setup.
	 *
	 * The primed knowledge entries are deliberately NOT kept here: they go into the
	 * provider's system prompt and are never needed again, and a per-call copy of
	 * every FAQ answer would sit in memory for the length of the call for nothing.
	 */
	profile: ActiveAgentProfile | null;

	status: LiveCallStatus;
	answered: boolean;
	ready: boolean;
	greetingSpoken: boolean;
	/** True once the channel has been handed to [ai-bridge]. */
	handedToDialplan: boolean;
	/** True when audio flows over AudioSocket (i.e. not the IVR fallback). */
	usesAudioSocket: boolean;
	/**
	 * Recording path for the fallback path, where MixMonitor is started over AMI
	 * rather than by [ai-bridge].
	 *
	 * Without this a call would only ever be recorded when a realtime model
	 * happened to be reachable. Recording is a product requirement in its own
	 * right, so it must not be coupled to the AI working.
	 */
	fallbackRecordingPath: string | null;

	transfer: TransferRecord;
	operatorUserId: string | null;

	interim: Map<TranscriptRole, InterimTranscript>;
	promptTokens: number;
	completionTokens: number;
	/** Prompt tokens the provider served from cache - roughly a tenth of the price. */
	cachedTokens: number;
	/**
	 * How the cached prefix split across modalities, or null on a provider that
	 * never reported it.
	 *
	 * Null rather than 0 because 0 is a measurement: it would tell the cost module
	 * the cached prefix contained no audio at all, and it would price a warm Gemini
	 * call as if every cached token were text.
	 */
	cachedAudioTokens: number | null;
	cachedTextTokens: number | null;
	inputAudioTokens: number;
	inputTextTokens: number;
	outputAudioTokens: number;
	outputTextTokens: number;
	/** How many times the model generated a reply. Prompt cost scales with this. */
	responseTurns: number;
	/** Separately-billed input transcription. Stays 0 on providers that transcribe in-session. */
	transcribeAudioTokens: number;
	transcribeTextTokens: number;
	transcribeModel: string | null;
	/**
	 * When the current silence window started - the last moment anything at all
	 * happened on this call. `touchActivity` is the only writer.
	 */
	lastActivityAt: number;

	/**
	 * Level meter over the caller's own inbound audio.
	 *
	 * The platform's only provider-independent evidence that a person is on the
	 * line. Always present, even on the fallback path where no audio is ever pushed
	 * into it - an untouched meter reports "no voice", which is the same answer as
	 * before this existed.
	 */
	callerVoice: CallerVoiceActivity;
	/** Throttles caller-speech notifications; see CALLER_SPEECH_NOTIFY_INTERVAL_MS. */
	lastCallerSpeechNotifyAt: number;
	/** How many times the agent was caught having answered nothing on this call. */
	agentStalls: number;
	/**
	 * How many times the provider transcribed the CALLER.
	 *
	 * The corroborating second opinion on the energy detector: the model is a far
	 * better speech detector than an RMS gate, so an energy signal it never turns
	 * into a single word is very likely not a person.
	 */
	callerTranscripts: number;

	endReason: string | null;
	/** True from the moment the closing line is requested: it must not be cut short. */
	closingSpeech: boolean;
	/** Set when the provider itself failed: makes the ai_session status "failed". */
	aiError: string | null;
	/** Set when there was never a usable AI: explains a failed ai_analysis. */
	unavailableReason: string | null;

	aiPathClosed: boolean;
	finalized: boolean;

	playbackId: string | null;
	greetingTimer: TimerHandle | null;
	maxDurationTimer: TimerHandle | null;
	/** "Is anybody on this line?" Reset by any activity, including caller speech. */
	silenceTimer: TimerHandle | null;
	/** "Is the agent answering?" Armed by caller speech, cleared by agent audio. */
	agentStallTimer: TimerHandle | null;
	finalizeTimer: TimerHandle | null;
}

interface PostCallTarget {
	callId: string;
	tenantId: TenantId;
	language: string;
	/** The business the call was answered for, when one is configured. */
	businessName: string | null;
	/** Its own ticket categories, so the summary is labelled in its words. */
	categories: readonly string[] | null;
	providerName: string | null;
	aiError: string | null;
	unavailableReason: string | null;
}

// ===========================================
// Small helpers
// ===========================================

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function describeError(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	return String(cause);
}

function readText(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function clearTimer(timer: TimerHandle | null): null {
	if (timer !== null) {
		clearTimeout(timer);
	}
	return null;
}

/**
 * A matched contact as the live-call snapshot and the prompt want it.
 *
 * Shared by both directions: the contact is looked up the same way whether they
 * rang us or we rang them, so the dashboard card and the agent's greeting are
 * built from the same shape.
 */
function toLiveCallContact(contact: ContactMatch | null): LiveCallContact | null {
	if (contact === null) {
		return null;
	}

	return {
		id: contact.id,
		firstName: contact.firstName,
		lastName: contact.lastName,
		contactName: contactName(contact.firstName, contact.lastName),
		address: contact.address,
	};
}

function contactName(firstName: string | null, lastName: string | null): string | null {
	const joined = [firstName, lastName]
		.filter((part) => readText(part) !== null)
		.join(" ")
		.trim();
	return joined.length > 0 ? joined : null;
}

function isRussian(language: string): boolean {
	return language.toLowerCase().startsWith("ru");
}

/** Lines the platform speaks itself, in the two languages the hotline serves. */
function goodbyeLine(language: string, kind: "silence" | "max-duration"): string {
	if (isRussian(language)) {
		return kind === "silence"
			? "Я вас не слышу. Завершаю звонок, пожалуйста, позвоните ещё раз."
			: "Время разговора истекло. Спасибо за обращение, до свидания.";
	}

	return kind === "silence"
		? "Sizni eshitmayapman. Qo'ng'iroqni yakunlayman, iltimos, qayta qo'ng'iroq qiling."
		: "Suhbat vaqti tugadi. Murojaatingiz uchun rahmat, xayr.";
}

/**
 * Said when the caller has spoken, stopped, and the agent has answered nothing at
 * all for a whole window.
 *
 * Deliberately not a goodbye: the caller is still there, still talking, and the
 * only thing that has failed is the model. It is also worth a try as a repair -
 * a fresh turn can be enough to restart a session that stopped producing them.
 */
function agentStallLine(language: string): string {
	return isRussian(language)
		? "Извините, я вас не расслышал. Пожалуйста, повторите ещё раз."
		: "Uzr, sizni eshitolmadim. Iltimos, yana bir bor takrorlang.";
}

/**
 * THE TWO GUARDS, AND WHY THERE ARE TWO.
 *
 * They answer different questions and they must not be wired to each other.
 *
 *   silence guard   "Is anybody on this line?" Reset by ANY sign of life - the
 *                   caller's own voice included - and it hangs the call up when a
 *                   whole window passes with none. This is the fix for the
 *                   reported bug: on call 6c5a2006 the only thing that reset it
 *                   was the provider saying it had transcribed something, so a
 *                   model that had gone deaf was indistinguishable from an empty
 *                   line. The caller talked for 31.6 s, got no reply, was cut off
 *                   at 28 s, and the transcript recorded "Jimlik 20000 ms davom
 *                   etdi" about a call somebody was speaking almost throughout.
 *
 *   agent-stall     "Is the agent answering?" Armed the moment the caller is
 *   guard           audible, cleared by any agent audio. It cannot be the silence
 *                   deadline, because caller speech resets that one - a version of
 *                   this that classified the silence expiry was unreachable code
 *                   on any call with a talking caller.
 *
 * Without the second guard a caller talking to a permanently stalled model is held
 * to the max-duration limit with nobody answering, which is up to fifteen minutes.
 * With it, the platform says something, records the fault and lets the caller
 * reach a human by pressing 0.
 */

/**
 * What a fired agent-stall timer is evidence of.
 *
 * The caller's own audio level is the input (see CallerVoiceActivity), so this is
 * independent of the provider entirely.
 *
 * @param msSinceCallerVoice ms since the caller was last audible, or null when
 *                           they never have been - including on the fallback path,
 *                           which has no AudioSocket to measure.
 * @param turnGapMs          how long the caller must have been quiet before an
 *                           unanswered turn counts as the agent's fault.
 */
export function classifyAgentStall(
	msSinceCallerVoice: number | null,
	turnGapMs: number
): "no-caller" | "caller-mid-turn" | "agent-stalled" {
	if (msSinceCallerVoice === null) {
		// Nothing was ever heard, so there is no unanswered turn. Either this is the
		// fallback path or the line is empty, and the silence guard owns both.
		return "no-caller";
	}

	if (msSinceCallerVoice < turnGapMs) {
		// Still talking, or only just stopped. A model that has not replied yet is
		// listening, which is what it is supposed to be doing.
		return "caller-mid-turn";
	}

	return "agent-stalled";
}

/**
 * Should a stall that only energy can see be believed any longer?
 *
 * Two signals disagree: the RMS detector says somebody is on the line, and the
 * provider - a far better speech detector - has never turned any of it into a
 * word. On a line whose noise swells and fades the detector is the one that is
 * wrong, and left unbounded it holds an empty call open until max-duration.
 *
 * One caller transcript is enough to settle it forever: somebody demonstrably
 * spoke, so the call is never abandoned this way afterwards, however long the
 * agent then struggles.
 */
export function isUncorroboratedStall(
	agentStalls: number,
	callerTranscripts: number,
	maxStalls: number
): boolean {
	return callerTranscripts === 0 && agentStalls > maxStalls;
}

/**
 * What a failed transfer leaves behind.
 *
 * The distinction matters because `announceBeforeAction` sets `closingSpeech`
 * before every transfer to stop a cough cutting the "connecting you to an
 * operator" line off mid-word. That protection has to end with the announcement:
 * when no operator answers, the caller is handed straight back to the agent and
 * spends the rest of the call unable to interrupt it, on a phone line, which is
 * the one place interrupting is how people talk.
 */
export type FailedTransferOutcome = "caller-gone" | "no-agent-left" | "back-to-agent";

export function classifyFailedTransfer(
	callerRetained: boolean,
	providerName: string | null
): FailedTransferOutcome {
	if (!callerRetained) {
		// [ai-transfer] hangs the caller up itself after a failed Dial.
		return "caller-gone";
	}

	if (providerName === FALLBACK_IVR_PROVIDER_NAME) {
		// There was never a model on this call, so there is nothing to hand back to.
		return "no-agent-left";
	}

	return "back-to-agent";
}

/**
 * Said before the caller is handed to a person.
 *
 * The instructions already ask the model to announce a transfer, but an
 * instruction is not a guarantee: when the model called the tool silently the
 * caller went from mid-conversation to ringing with no explanation. This line is
 * the platform's own fallback for that case.
 */
function transferAnnouncement(language: string): string {
	return isRussian(language)
		? "Соединяю вас с оператором, пожалуйста, оставайтесь на линии."
		: "Sizni operatorga ulayapman, iltimos, liniyada qoling.";
}

/** Said before the platform hangs up on the model's behalf. */
function closingAnnouncement(language: string): string {
	return isRussian(language)
		? "Спасибо за обращение. До свидания."
		: "Murojaatingiz uchun rahmat. Xayr.";
}

/**
 * The tenant's Asterisk name: what the dialplan said, or the tenant row's own slug.
 *
 * Both answers are the same string in every healthy case; the row is consulted
 * because a call can still arrive through a pre-tenancy context that names no
 * tenant, and a call whose slug is unknown loses its own contexts, its own
 * endpoints and its own recording directory. Never throws - a slug that cannot be
 * read leaves every consumer on the pre-tenancy names.
 */
async function resolveTenantSlug(
	tenantId: TenantId,
	claimed: string | null
): Promise<string | null> {
	if (claimed !== null) {
		return claimed;
	}

	try {
		const tenant = await getTenantById(tenantId);

		return tenant?.slug ?? null;
	} catch (cause) {
		logger.warn({ err: cause, tenantId }, "could not read the tenant slug for this call");

		return null;
	}
}

/**
 * Where this call's recording is written: `<dir>/<slug>/<calls.id>.wav`.
 *
 * ONE function, because two producers have to agree on the answer: MixMonitor
 * started by [ai-bridge-<slug>] (which builds the same path from ${CONTEXT}) and
 * MixMonitor started over AMI on the IVR fallback path (which is handed this
 * string). A tenant directory rather than one flat one because the route that
 * serves a recording cannot require a header - see routes/uploads - so the
 * directory is the boundary between two customers' audio.
 *
 * Flat, exactly as before, when the tenant has no name we can use: a file with no
 * home is better than a file in a directory named after a guess.
 */
function recordingPathFor(callId: string, tenantSlug: string | null): string {
	const env = getServerEnv();
	const base = env.ASTERISK_RECORDINGS_DIR.replace(/\/+$/, "");

	return tenantSlug === null ? `${base}/${callId}.wav` : `${base}/${tenantSlug}/${callId}.wav`;
}

/**
 * The pause before the greeting, as configured right now.
 *
 * Read per call rather than captured in the constructor: this orchestrator is a
 * process-wide singleton, so a value read once at construction could only be
 * changed by a restart - and the AI settings page is expected to reach the next
 * caller. Same reasoning applies to the language and the two call limits below.
 */
function configuredGreetingDelayMs(tenantId: TenantId): number {
	return getAiRuntimeConfig(tenantId).greetingDelayMs;
}

// ===========================================
// Default post-call summariser
// ===========================================

const CallSummarySchema = z.object({
	summary: z.string().trim().min(1).max(2000),
	sentiment: z.enum(["positive", "neutral", "negative"]).default("neutral"),
	categories: z.array(z.string().trim().min(1).max(100)).max(8).default([]),
	confidence: z.coerce.number().min(0).max(100).optional(),
});

interface ChatCompletionResponse {
	choices?: Array<{ message?: { content?: string } }>;
	/** Always present on a 2xx. Every finished call pays for it, and a retry pays again. */
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
	};
	error?: { message?: string; code?: string };
}

/**
 * The summariser's own instructions, built per call.
 *
 * The business and its categories are arguments rather than constants for the
 * same reason the agent's prompt is: the label an owner reads on their dashboard
 * has to be one of THEIR categories, and a summariser told it is analysing a
 * municipal hotline will happily invent municipal categories for a dental clinic.
 */
function buildAnalysisSystemPrompt(input: CallSummaryInput): string {
	const business =
		input.businessName === undefined || input.businessName.trim().length === 0
			? "a business"
			: `"${input.businessName.trim()}"`;
	const categories = normaliseTicketCategories([...(input.categories ?? [])]);
	const categoryRule =
		categories.length > 0
			? `an array of one to three labels chosen from ${categories.join(", ")}`
			: "an array of one to three short labels of your own, in the language of the call";

	return (
		`You are a quality analyst for the telephone line of ${business}. You are given ` +
		"the transcript of one call between a caller and the business's automated agent. " +
		"Answer with a single JSON object and nothing else, using exactly these keys: " +
		'"summary" (2-4 sentences in the language of the call, stating what the caller ' +
		'wanted, what they were told, and what was written down), "sentiment" (one of ' +
		'positive, neutral, negative, describing the caller), "categories" (' +
		`${categoryRule}), and "confidence" (an integer from 0 to 100 for how sure you ` +
		"are). Never invent facts that are not in the transcript."
	);
}

/**
 * Summarise a finished call with the text model.
 *
 * Deliberately NOT the realtime model: this project's key has no realtime
 * entitlement but does have gpt-4o-mini text chat, which is all a summary needs.
 * Every failure path throws with a message worth storing, because that message
 * is what an operator sees in the AI queue.
 */
async function requestCallAnalysis(apiKey: string, input: CallSummaryInput): Promise<Response> {
	const transcript =
		input.transcript.length > ANALYSIS_MAX_TRANSCRIPT_CHARS
			? `${input.transcript.slice(0, ANALYSIS_MAX_TRANSCRIPT_CHARS)}\n[...truncated...]`
			: input.transcript;

	try {
		return await fetch(ANALYSIS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: getAiRuntimeConfig(input.tenantId).analysisModel,
				temperature: 0.2,
				max_tokens: ANALYSIS_MAX_TOKENS,
				response_format: { type: "json_object" },
				messages: [
					{ role: "system", content: buildAnalysisSystemPrompt(input) },
					{
						role: "user",
						content: `Call language: ${input.language}\n\nTranscript:\n${transcript}`,
					},
				],
			}),
			signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
		});
	} catch (cause) {
		throw new Error(`the analysis model could not be reached: ${describeError(cause)}`);
	}
}

/** Turn a non-2xx analysis reply into the error message worth storing. */
async function callAnalysisFailure(response: Response): Promise<Error> {
	const body = await response.text().catch(() => "");
	let detail = body.slice(0, 300);

	try {
		const parsed = JSON.parse(body) as ChatCompletionResponse;

		if (parsed.error?.message !== undefined) {
			const code = parsed.error.code === undefined ? "" : ` (${parsed.error.code})`;
			detail = `${parsed.error.message}${code}`;
		}
	} catch {
		// Not JSON - the truncated body above is the best detail available.
	}

	return new Error(`the analysis model returned HTTP ${response.status}: ${detail}`);
}

function readAnalysisUsage(
	tenantId: TenantId,
	payload: ChatCompletionResponse
): CallSummaryUsage | undefined {
	const usage = payload.usage;

	if (usage === undefined) {
		return undefined;
	}

	return {
		model: getAiRuntimeConfig(tenantId).analysisModel,
		promptTokens: usage.prompt_tokens ?? 0,
		cachedPromptTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
	};
}

function parseCallAnalysis(content: string): CallSummary {
	let parsed: unknown;

	try {
		parsed = JSON.parse(content);
	} catch (cause) {
		throw new Error(`the analysis model did not return JSON: ${describeError(cause)}`);
	}

	const result = CallSummarySchema.safeParse(parsed);

	if (!result.success) {
		throw new Error(
			`the analysis JSON did not match the expected shape: ${z.prettifyError(result.error)}`
		);
	}

	return {
		summary: result.data.summary,
		sentiment: result.data.sentiment,
		categories: result.data.categories,
		confidence: result.data.confidence ?? null,
	};
}

export async function summariseCallWithOpenAi(input: CallSummaryInput): Promise<CallSummary> {
	const apiKey = (getServerEnv().OPENAI_API_KEY ?? "").trim();

	if (apiKey.length === 0) {
		throw new Error("OPENAI_API_KEY is not set, so no post-call summary can be produced");
	}

	const response = await requestCallAnalysis(apiKey, input);

	if (!response.ok) {
		throw await callAnalysisFailure(response);
	}

	const payload = (await response.json()) as ChatCompletionResponse;
	const content = payload.choices?.[0]?.message?.content ?? "";

	if (content.trim().length === 0) {
		throw new Error("the analysis model returned an empty answer");
	}

	return { ...parseCallAnalysis(content), usage: readAnalysisUsage(input.tenantId, payload) };
}

// ===========================================
// Orchestrator
// ===========================================

export class CallOrchestrator {
	private readonly ari: AriClient;
	private readonly events: AriEventStream;
	private readonly audioSocket: AudioSocketServer;
	private readonly providerFactory: (setup: VoiceProviderSetup) => Promise<VoiceProvider>;
	private readonly summarise: CallSummariser;
	/** Set only when a caller pinned it; otherwise the configured value is read per call. */
	private readonly greetingDelayOverrideMs: number | undefined;

	private readonly calls = new Map<string, ActiveCall>();
	private readonly callsByChannel = new Map<string, string>();
	private readonly playbackWaiters = new Map<string, () => void>();
	private readonly background = new Set<Promise<void>>();
	/**
	 * Campaign dials that are ringing, keyed by the channel id we pre-assigned.
	 *
	 * Keyed by channel rather than by call id because the two events that settle a
	 * dial - StasisStart and ChannelDestroyed - both identify the channel and
	 * neither knows anything about a campaign.
	 */
	private readonly pendingDials = new Map<string, PendingOutboundDial>();

	private unsubscribers: Array<() => void> = [];
	private running = false;
	private startPromise: Promise<void> | null = null;

	constructor(options: CallOrchestratorOptions = {}) {
		const env = getServerEnv();

		this.ari = options.ari ?? getAriClient();
		this.events = options.events ?? new AriEventStream({ app: env.ASTERISK_ARI_APP });
		this.audioSocket =
			options.audioSocket ??
			new AudioSocketServer({ host: env.AUDIOSOCKET_HOST, port: env.AUDIOSOCKET_PORT });
		this.providerFactory =
			options.providerFactory ??
			((setup) =>
				resolveVoiceProvider({
					tenantId: setup.tenantId,
					profile: setup.profile,
					knowledge: setup.knowledge,
				}));
		this.summarise = options.summarise ?? summariseCallWithOpenAi;
		this.greetingDelayOverrideMs = options.greetingDelayMs;
	}

	get isRunning(): boolean {
		return this.running;
	}

	get activeCallCount(): number {
		return this.calls.size;
	}

	/**
	 * How many outbound calls this process currently has out, ringing or talking.
	 *
	 * The number the concurrency limits are actually about. The dialer's own
	 * database count (`campaign_leads.status = 'calling'`) answers a subtly
	 * different question and is wrong in both directions for this purpose: it
	 * misses a manual test dial that belongs to no campaign, and it drops a lead
	 * the moment the agent records an outcome - which happens mid-conversation, so
	 * a channel that is still up and still costing money would stop counting
	 * against the budget. The dialer takes the larger of the two.
	 *
	 * `campaignId` narrows it to one campaign's calls; omit it for the
	 * platform-wide figure that `ai.outbound.maxConcurrentCalls` caps.
	 */
	countOutboundInFlight(campaignId?: string | null): number {
		const wanted = campaignId ?? null;
		let total = 0;

		for (const pending of this.pendingDials.values()) {
			if (wanted === null || pending.campaignId === wanted) {
				total += 1;
			}
		}

		for (const call of this.calls.values()) {
			if (call.outbound !== null && (wanted === null || call.outbound.campaignId === wanted)) {
				total += 1;
			}
		}

		return total;
	}

	// -----------------------------------------
	// Lifecycle
	// -----------------------------------------

	/** Bind the AudioSocket listener, subscribe to ARI, and start the event stream. */
	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		if (this.startPromise !== null) {
			await this.startPromise;
			return;
		}

		this.startPromise = this.startInternal();

		try {
			await this.startPromise;
		} finally {
			this.startPromise = null;
		}
	}

	private async startInternal(): Promise<void> {
		const env = getServerEnv();
		const address = await this.audioSocket.start();

		this.subscribe();
		this.events.start();
		this.running = true;

		// Resolve the stored AI settings once at boot as well as per call, so the
		// synchronous readers (timers, spoken lines) are warm before the first
		// caller and the log line below states what is actually configured.
		//
		// TODO(tenancy): warms the ONE customer that exists. A multi-tenant boot has
		// nothing to warm - each call warms its own tenant in launchProvider() - so a
		// failure here is logged and ignored rather than delaying the phone line.
		const bootTenantId = await getSoleTenantId().catch((err: unknown) => {
			logger.warn({ err }, "no single tenant to warm the AI settings for at boot");
			return null;
		});
		const ai = await this.resolveAiSettings(bootTenantId);

		logger.info(
			{
				audioSocket: address,
				advertisedAs: env.AUDIOSOCKET_ADVERTISE_HOST,
				ariApp: env.ASTERISK_ARI_APP,
				aiEnabled: ai.enabled,
				aiProvider: ai.provider,
				maxCallSeconds: ai.maxCallSeconds,
			},
			"call orchestrator started"
		);
	}

	/**
	 * Never lets a settings read stop the phone from being answered.
	 *
	 * A database that is down here would otherwise take the whole voice layer with
	 * it; the fallback is the .env layer, which is what the process booted with.
	 */
	private async resolveAiSettings(tenantId: TenantId | null): Promise<AiRuntimeConfig> {
		if (tenantId === null) {
			// No tenant known here (boot, before any tenant exists). The .env layer is
			// the only honest answer; picking a customer's stored settings would be
			// picking a customer.
			return getAiRuntimeConfig(null);
		}

		try {
			return await refreshAiRuntimeConfig(tenantId);
		} catch (err) {
			logger.error({ err }, "could not read the AI settings - using the .env values for now");
			return getAiRuntimeConfig(tenantId);
		}
	}

	/**
	 * Stop accepting calls and close everything down.
	 *
	 * Live calls are finalised rather than abandoned: the AudioSocket listener is
	 * about to close, which makes Asterisk's AudioSocket() return and the dialplan
	 * hang the caller up, so the call really is over and the row must say so.
	 */
	async stop(): Promise<void> {
		if (!(this.running || this.unsubscribers.length > 0)) {
			return;
		}

		this.running = false;

		for (const unsubscribe of this.unsubscribers) {
			unsubscribe();
		}
		this.unsubscribers = [];
		this.events.stop();

		// Ringing campaign dials first, and before the live calls: nothing is listening
		// for StasisStart any more, so a phone that is picked up a second from now would
		// reach silence. Cutting the channel and filing the dial as failed is the honest
		// answer, and it releases the dialer's concurrency slot instead of leaving a
		// `calls` row at "ringing" across the restart.
		for (const pending of [...this.pendingDials.values()]) {
			await this.quietly("shutdown dial", () =>
				this.abandonOutboundDial(pending, {
					outcome: "failed",
					reason: "Tizim qayta ishga tushirilgani uchun qo'ng'iroq to'xtatildi",
				})
			);
			await this.quietly("shutdown dial hangup", () =>
				this.ari.hangup(pending.channelId, "normal")
			);
		}

		for (const call of [...this.calls.values()]) {
			await this.quietly("shutdown finalise", () =>
				this.finalizeCall(call, { reason: "backend-shutdown" })
			);
		}

		await this.quietly("audiosocket stop", () => this.audioSocket.stop());
		await Promise.allSettled([...this.background]);

		logger.info("call orchestrator stopped");
	}

	private subscribe(): void {
		this.unsubscribers.push(
			this.events.on("StasisStart", (event) => {
				this.handleStasisStart(event);
			}),
			this.events.on("StasisEnd", (event) => {
				this.handleStasisEnd(event);
			}),
			this.events.on("ChannelDestroyed", (event) => {
				this.handleChannelDestroyed(event);
			}),
			this.events.on("PlaybackFinished", (event) => {
				this.settlePlayback(event.playback.id);
			}),
			this.events.on("ChannelLeftBridge", (event) => {
				this.handleChannelLeftBridge(event);
			}),
			this.audioSocket.on("session", (session) => {
				this.attachAudioSocketSession(session);
			}),
			this.audioSocket.on("error", (error, session) => {
				logger.error(
					{ err: error, kind: error.kind, callId: session?.uuid ?? null },
					"AudioSocket error"
				);
			})
		);
	}

	// -----------------------------------------
	// Public control surface (used by the HTTP routes)
	// -----------------------------------------

	/**
	 * One customer's live calls.
	 *
	 * The tenant is REQUIRED, and every one of the four methods below takes it. This
	 * map is process-wide - one orchestrator serves every customer on the box - so it
	 * is the one read path where nothing in the database can save a forgotten filter.
	 * A required parameter is the only version of this that a later phase cannot
	 * accidentally regress.
	 */
	listActiveCalls(tenantId: TenantId): LiveCallSnapshot[] {
		return [...this.calls.values()]
			.filter((call) => call.tenantId === tenantId)
			.map((call) => this.snapshot(call));
	}

	/** How many calls this customer has live. The platform-wide count is a different question. */
	activeCallCountFor(tenantId: TenantId): number {
		let total = 0;

		for (const call of this.calls.values()) {
			if (call.tenantId === tenantId) {
				total += 1;
			}
		}

		return total;
	}

	/** Null for a call that is not live OR belongs to another customer - the same answer. */
	getActiveCall(tenantId: TenantId, callId: string): LiveCallSnapshot | null {
		const call = this.calls.get(callId);

		if (call === undefined || call.tenantId !== tenantId) {
			return null;
		}

		return this.snapshot(call);
	}

	/**
	 * Hang a live call up. Safe to call for a call that has already gone.
	 *
	 * False for another customer's live call, exactly as for one that does not exist:
	 * the caller turns that into a 404, so "nothing happened" and "not yours" are
	 * indistinguishable from outside.
	 */
	async hangupCall(tenantId: TenantId, callId: string, reason = "manual-hangup"): Promise<boolean> {
		const call = this.calls.get(callId);

		if (call === undefined || call.tenantId !== tenantId) {
			return false;
		}

		call.status = call.status === "ended" ? call.status : "ending";
		call.endReason = reason;

		await this.endAiPath(call, { reason });

		if (call.session !== null) {
			try {
				// Sends the AudioSocket terminate packet, which makes the dialplan
				// fall through to Hangup().
				call.session.hangup();
			} catch (cause) {
				logger.debug({ err: cause, callId }, "AudioSocket hangup threw, ignoring");
			}
		}

		await this.quietly("ari.hangup", () => this.ari.hangup(call.channelId, "normal"));
		this.armFinalizeSafety(call, reason);

		return true;
	}

	/**
	 * Ask for a human, from the dashboard rather than from the model.
	 *
	 * Null for another customer's call. Transferring is the most dangerous of the four:
	 * it would have rung an operator in the wrong company and handed them a stranger's
	 * caller.
	 */
	async transferCall(
		tenantId: TenantId,
		callId: string,
		input: { reason: string; preferredExtension?: string | null }
	): Promise<TransferOutcome | null> {
		const call = this.calls.get(callId);

		if (call === undefined || call.tenantId !== tenantId) {
			return null;
		}

		return await this.startTransfer(call, input);
	}

	// -----------------------------------------
	// ARI events
	// -----------------------------------------

	private handleStasisStart(event: AriEventOf<"StasisStart">): void {
		const channel = event.channel;

		if (event.args[0] === TRANSFER_LEG_ARG) {
			// The operator leg transfer.ts originated. It bridges the leg itself; we
			// must not treat it as a new inbound call.
			logger.debug({ channelId: channel.id, args: event.args }, "transfer leg entered Stasis");
			return;
		}

		if (this.callsByChannel.has(channel.id)) {
			logger.debug({ channelId: channel.id }, "channel is already tracked, ignoring StasisStart");
			return;
		}

		if (event.args[0] === OUTBOUND_LEG_ARG) {
			// The person we rang has picked up. Same Stasis application, same
			// orchestrator, different entry point - and emphatically NOT a new inbound
			// call, which is what it would look like without this branch.
			this.track(this.claimOutboundDial(channel), `claimOutboundDial ${channel.id}`);
			return;
		}

		// The Stasis arguments travel with the channel: they are where the dialplan says
		// `tenant=<slug>` once the per-tenant contexts exist.
		this.track(this.beginCall(channel, event.args), `beginCall ${channel.id}`);
	}

	private handleStasisEnd(event: AriEventOf<"StasisEnd">): void {
		const call = this.findByChannel(event.channel.id);

		if (call === null) {
			return;
		}

		if (call.handedToDialplan) {
			// Expected: we handed the channel to [ai-bridge] ourselves. The call is
			// very much alive - the audio path is AudioSocket now.
			logger.debug(
				{ callId: call.callId, channelId: call.channelId },
				"channel left Stasis for the AudioSocket bridge"
			);
			return;
		}

		logger.info(
			{ callId: call.callId, channelId: call.channelId },
			"channel left Stasis before the bridge; finalising the call"
		);
		this.track(this.finalizeCall(call, { reason: "stasis-end" }), `finalise ${call.callId}`);
	}

	private handleChannelDestroyed(event: AriEventOf<"ChannelDestroyed">): void {
		const pending = this.pendingDials.get(event.channel.id);

		if (pending !== undefined) {
			// A campaign dial that died before anybody picked up. The Q.850 cause on this
			// event is the ONLY evidence there is about what happened to that phone, and
			// it is what decides whether the dialer ever tries again - so it is read here
			// and nowhere else.
			this.track(
				this.abandonOutboundDial(pending, classifyHangupCause(event.cause, event.cause_txt)),
				`abandonOutboundDial ${pending.callId}`
			);
			return;
		}

		const call = this.findByChannel(event.channel.id);

		if (call === null) {
			return;
		}

		logger.info(
			{ callId: call.callId, cause: event.cause, causeText: event.cause_txt },
			"channel destroyed"
		);
		this.track(
			this.finalizeCall(call, { reason: `channel-destroyed:${event.cause_txt}` }),
			`finalise ${call.callId}`
		);
	}

	/**
	 * The operator hung up on a transferred call.
	 *
	 * On the ARI-bridge strategy the caller is left alone in a mixing bridge that
	 * nothing else will ever clear, which is dead air by another name. Releasing
	 * the caller (and the bridge) here is the safety net for that. On the
	 * AMI-redirect strategy the dialplan has already hung the caller up, and both
	 * the ARI hangup and the finalise below are no-ops.
	 */
	private handleChannelLeftBridge(event: AriEventOf<"ChannelLeftBridge">): void {
		const call = this.findByTransferChannel(event.channel.id);

		if (call === null) {
			return;
		}

		logger.info(
			{ callId: call.callId, bridgeId: event.bridge.id, operatorChannel: event.channel.id },
			"the operator left the transfer bridge; releasing the caller"
		);
		this.track(
			this.releaseAfterTransfer(call, event.bridge.id),
			`release after transfer ${call.callId}`
		);
	}

	private async releaseAfterTransfer(call: ActiveCall, bridgeId: string): Promise<void> {
		await this.hangupCall(call.tenantId, call.callId, "operator-left-bridge");
		await this.quietly("ari.destroyBridge", () => this.ari.destroyBridge(bridgeId));
	}

	private findByChannel(channelId: string): ActiveCall | null {
		const callId = this.callsByChannel.get(channelId);

		if (callId === undefined) {
			return null;
		}

		return this.calls.get(callId) ?? null;
	}

	private findByTransferChannel(channelId: string): ActiveCall | null {
		for (const call of this.calls.values()) {
			if (call.transfer.phase === "connected" && call.transfer.toChannelId === channelId) {
				return call;
			}
		}

		return null;
	}

	// -----------------------------------------
	// Call setup
	// -----------------------------------------

	private async beginCall(channel: AsteriskChannel, args: string[] = []): Promise<void> {
		const callerNumber =
			readText(channel.caller.number) ?? readText(channel.connected.number) ?? "";
		const dialledExtension = readText(channel.dialplan.exten);

		let created: CreateInboundCallResult;
		// What the CHANNEL said its tenant was, kept out of the try so the call record
		// below can be named with it. Null means the channel carried no statement -
		// a pre-tenancy context - and the tenant row's own slug is used instead.
		let tenantSlugFromChannel: string | null = null;

		try {
			// WHOSE CALL IS THIS - resolved before anything is written, from the channel
			// itself (inbound-tenant.ts explains the four sources and today's fallback).
			// Everything the rest of this call writes inherits the answer, so it is
			// resolved once, here, and carried on the ActiveCall rather than re-derived.
			const tenant = await resolveInboundTenant(channel, args);

			tenantSlugFromChannel = tenant.slug;

			logger.info(
				{
					channelId: channel.id,
					context: channel.dialplan.context,
					channelName: channel.name,
					tenantId: tenant.tenantId,
					tenantSlug: tenant.slug,
					tenantSource: tenant.source,
					tenantOperational: tenant.operational,
				},
				"resolved the tenant for an inbound channel"
			);

			created = await createInboundCall({
				tenantId: tenant.tenantId,
				callerNumber,
				channelId: channel.id,
				direction: "inbound",
				calleeExtension: dialledExtension,
			});
		} catch (cause) {
			// No CRM row means nothing can be tracked; the honest answer is to release
			// the channel rather than leave the caller in silence inside Stasis.
			// A channel whose tenant cannot be resolved lands here too, and releasing it
			// is the right answer: a call nobody can attribute is a call nobody can
			// record, bill or answer for.
			logger.error(
				{ err: cause, channelId: channel.id, context: channel.dialplan.context, callerNumber },
				"could not resolve the tenant or create the call row; releasing the channel"
			);
			await this.quietly("ari.hangup", () => this.ari.hangup(channel.id, "congestion"));
			return;
		}

		const call = this.createActiveCall({
			callId: created.callId,
			tenantId: created.tenantId,
			// The dialplan usually said it outright (Stasis(...,tenant=avilab)); when it
			// did not, the tenant row still knows its own slug. Either way the name is
			// fixed now, before a single context or endpoint name is built from it.
			tenantSlug: await resolveTenantSlug(created.tenantId, tenantSlugFromChannel),
			channel,
			callerNumber,
			dialledExtension,
			direction: "inbound",
			outbound: null,
			contact: toLiveCallContact(created.contact),
			startedAt: created.startedAt,
		});

		this.calls.set(call.callId, call);
		this.callsByChannel.set(channel.id, call.callId);
		this.broadcast({ type: LIVE_CALL_EVENTS.started, call: this.snapshot(call) }, call);

		try {
			await this.ari.answer(channel.id);
			call.answered = true;
			await this.quietly("markCallAnswered", () => markCallAnswered(call.tenantId, call.callId));
			await this.launchProvider(call);
		} catch (cause) {
			await this.abortCall(call, cause);
		}
	}

	// -----------------------------------------
	// Outbound campaign calls
	// -----------------------------------------

	/**
	 * Ring somebody, and let the existing machine run the call from there.
	 *
	 * THE SEAM. Everything the dialer needs and nothing about ARI: it says who to
	 * ring and why, and gets back either a live call id or a refusal it can file
	 * against the lead. What happens after the phone is answered is not a second
	 * implementation of anything - the channel enters the same Stasis application an
	 * inbound caller enters, so it gets the same AI session, the same silence and
	 * stall guards, the same barge-in, the same CRM writes, the same MixMonitor
	 * recording and the same cost accounting, for free.
	 *
	 * The order below is deliberate and the do-not-call check is the reason:
	 *
	 *   1. resolve the endpoint from CONFIGURATION (never a hardcoded dial string)
	 *   2. refuse a number nobody could dial
	 *   3. CHECK THE DO-NOT-CALL LIST - before a row is written, before a contact is
	 *      touched, before Asterisk is asked for anything
	 *   4. write the `calls` row, so a phone nobody answers still leaves a record
	 *   5. park the dial, THEN originate
	 *
	 * Step 3 is here rather than only in the dialer because this is the narrowest
	 * point every dial has to pass through. A future "ring this person now" button,
	 * a retry, a manual test call - none of them can forget it.
	 *
	 * Step 5 is in that order because the two are a race: StasisStart arrives on the
	 * event socket while the originate response is still in flight on the REST
	 * connection, and it regularly wins. Parking the dial first is what stops an
	 * answered campaign call being mistaken for a new inbound one.
	 */
	async placeOutboundCall(request: OutboundCallRequest): Promise<PlaceOutboundCallResult> {
		if (!this.running) {
			// Nothing is listening for StasisStart, so the person would answer and hear
			// silence. Not the lead's fault, so no outcome is filed against them.
			return {
				placed: false,
				refusal: "not_running",
				message:
					"Telefoniya xizmati ishga tushmagan, shu sababli qo'ng'iroq qilinmadi. Keyinroq qayta urinib ko'ring.",
				outcome: null,
				callId: null,
			};
		}

		const dialing = describeOutboundDialing(request.tenantId);
		const resolved = resolveOutboundEndpoint(request.number, dialing.pattern);

		if (resolved === null) {
			return {
				placed: false,
				refusal: "invalid_number",
				message: "Raqam yaroqsiz: qo'ng'iroq qilish uchun raqamda 3–20 ta raqam bo'lishi kerak.",
				outcome: "invalid_number",
				callId: null,
			};
		}

		const { endpoint, digits } = resolved;

		if (await isDoNotCallNumber(request.tenantId, digits)) {
			logger.info(
				{ phone: digits, campaignId: request.campaignId ?? null },
				"refusing to dial: the number is on the do-not-call list"
			);

			return {
				placed: false,
				refusal: "do_not_call",
				message: "Bu raqam «qo'ng'iroq qilinmasin» ro'yxatida, shu sababli qo'ng'iroq qilinmadi.",
				outcome: "opt_out",
				callId: null,
			};
		}

		let created: CreateInboundCallResult;

		try {
			created = await createInboundCall({
				tenantId: request.tenantId,
				callerNumber: digits,
				// A label, not a channel: the real channel id is chosen below and IS the
				// call id, which cannot be known until this insert returns. crm-writer uses
				// this only to correlate its own log line for the insert.
				channelId: `outbound-dial:${digits}`,
				direction: "outbound",
				// Null on purpose. `callee_extension` means "which of OUR extensions was
				// dialled", and on an outbound call none was. Filling it with the number we
				// rang would also make resolveOperatorProfileIdByExtension attach a desk
				// operator to the row whenever a campaign happens to ring an internal
				// extension - which is how the internal test dials look - and the call
				// would then appear on that operator's own list as work they handled.
				calleeExtension: null,
			});
		} catch (cause) {
			logger.error(
				{ err: cause, phone: digits },
				"could not create the call row for an outbound dial; nothing was rung"
			);

			return {
				placed: false,
				refusal: "originate_failed",
				message: "Qo'ng'iroq yozuvini yaratib bo'lmadi, shu sababli qo'ng'iroq qilinmadi.",
				outcome: null,
				callId: null,
			};
		}

		const ringSeconds = request.ringTimeoutSeconds ?? dialing.ringTimeoutSeconds;
		// calls.id doubles as the channel id. It is already a uuid, it is already the
		// AudioSocket UUID, and reusing it means a log line, a channel, a recording
		// filename and a CRM row all carry one identifier.
		const channelId = created.callId;
		const pending: PendingOutboundDial = {
			callId: created.callId,
			tenantId: created.tenantId,
			channelId,
			phone: digits,
			endpoint,
			campaign: request.purpose,
			campaignId: request.campaignId ?? null,
			leadId: request.leadId ?? null,
			requestedByUserId: request.requestedByUserId ?? null,
			contact: toLiveCallContact(created.contact),
			startedAt: created.startedAt,
			startedAtMs: created.startedAt.getTime(),
			graceTimer: null,
			settled: false,
		};

		this.pendingDials.set(channelId, pending);
		this.armDialWatchdog(pending, ringSeconds);
		await this.writeDialAuditNote(pending, dialing.callerId);

		logger.info(
			{
				callId: pending.callId,
				channelId,
				endpoint,
				phone: digits,
				campaignId: pending.campaignId,
				leadId: pending.leadId,
				kind: request.purpose.kind,
				campaign: request.purpose.campaignName,
				ringSeconds,
				trunkConfigured: dialing.trunkConfigured,
			},
			"placing an outbound campaign call"
		);

		try {
			await this.ari.originate({
				endpoint,
				channelId,
				// No `extension`: THIS is what makes the answered channel enter our own
				// Stasis application instead of the dialplan. [click-to-call] is the
				// operator-first flow and is not this - a campaign call has no operator leg.
				appArgs: `${OUTBOUND_LEG_ARG},${pending.callId}`,
				callerId: dialing.callerId ?? undefined,
				timeout: ringSeconds,
				// AS_UUID early so the channel already carries its CRM identity before
				// [ai-bridge] ever reads it; handToBridge sets the same value again.
				variables: { AS_UUID: pending.callId, CAMPAIGN_CALL: "1" },
			});
		} catch (cause) {
			// Asterisk refused the dial outright: no such endpoint, no channel available,
			// a trunk that is not registered. ChannelDestroyed will never arrive for a
			// channel that was never created, so this is the only chance to settle it.
			const verdict = this.classifyOriginateFailure(cause);

			logger.error(
				{ err: cause, callId: pending.callId, endpoint, outcome: verdict.outcome },
				"ARI refused the outbound dial"
			);

			await this.abandonOutboundDial(pending, verdict);

			return {
				placed: false,
				refusal: "originate_failed",
				message: dialing.warning ?? verdict.reason,
				outcome: verdict.outcome,
				callId: pending.callId,
			};
		}

		return {
			placed: true,
			callId: pending.callId,
			channelId,
			endpoint,
			phone: digits,
		};
	}

	/**
	 * Read a refused originate as a campaign outcome.
	 *
	 * ARI answers 404 when the endpoint does not exist at all, which for a campaign
	 * means the number cannot be reached through this deployment's dial pattern -
	 * retrying it tonight will fail identically, so it is reported as an invalid
	 * number rather than as a no-answer. Everything else is a retryable failure of
	 * ours, not a fact about the person.
	 */
	private classifyOriginateFailure(cause: unknown): { outcome: OutboundOutcome; reason: string } {
		if (cause instanceof AriRequestError && cause.status === 404) {
			return {
				outcome: "invalid_number",
				reason: "Bunday raqam yoki yo'nalish topilmadi (Asterisk 404)",
			};
		}

		return {
			outcome: "failed",
			reason: `Qo'ng'iroqni boshlab bo'lmadi: ${describeError(cause)}`,
		};
	}

	/**
	 * Who launched this campaign, and what it was for, on the call itself.
	 *
	 * The audit trail requirement, answered where it is actually useful. The
	 * campaign tables know this too, but a note on the call means the /calls/:id
	 * card explains itself months later next to the transcript and the recording,
	 * with nothing to join - including for a call that was never answered and so has
	 * no transcript to explain it.
	 */
	private async writeDialAuditNote(
		pending: PendingOutboundDial,
		callerId: string | null
	): Promise<void> {
		const campaign = pending.campaign;
		const lines = [
			`Chiquvchi kampaniya qo'ng'irog'i (${campaign.kind}).`,
			campaign.campaignName === null ? null : `Kampaniya: «${campaign.campaignName}».`,
			`Maqsad: ${readText(campaign.purpose) ?? "ko'rsatilmagan"}`,
			`Terildi: ${pending.endpoint}${callerId === null ? "" : ` (Caller ID ${callerId})`}`,
		].filter((line): line is string => line !== null);

		await this.quietly("addNote(outbound-audit)", () =>
			addNote(pending.tenantId, {
				callId: pending.callId,
				// "system", not "ai": the platform placed this call because a person asked
				// it to, and the agent had not said a word yet. authorUserId is who asked.
				authorType: "system",
				authorUserId: pending.requestedByUserId,
				content: lines.join(" "),
			})
		);
	}

	/**
	 * The last resort for a dial that produces no event at all.
	 *
	 * Both real endings settle the dial themselves - StasisStart on an answer,
	 * ChannelDestroyed on a no-answer - so this timer normally never fires. It exists
	 * because the alternative to a watchdog is a `calls` row stuck at "ringing" for
	 * ever, holding a slot in the dialer's concurrency budget behind it, whenever
	 * Asterisk restarts or the event socket reconnects past the one event we needed.
	 */
	private armDialWatchdog(pending: PendingOutboundDial, ringSeconds: number): void {
		pending.graceTimer = setTimeout(
			() => {
				pending.graceTimer = null;

				if (pending.settled) {
					return;
				}

				logger.warn(
					{ callId: pending.callId, channelId: pending.channelId },
					"an outbound dial produced neither an answer nor a hangup; giving up on it"
				);

				this.track(
					this.abandonOutboundDial(pending, {
						outcome: "failed",
						reason: "Qo'ng'iroqdan hech qanday javob signali kelmadi",
					}).then(() =>
						// The channel may still exist and be ringing a phone nobody will ever
						// be connected to, so it is cut rather than left.
						this.quietly("ari.hangup(stale-dial)", () =>
							this.ari.hangup(pending.channelId, "normal")
						)
					),
					`abandonOutboundDial ${pending.callId}`
				);
			},
			ringSeconds * 1_000 + OUTBOUND_DIAL_GRACE_MS
		);
	}

	/** Take a dial out of the pending set exactly once. */
	private settleDial(pending: PendingOutboundDial): boolean {
		if (pending.settled) {
			return false;
		}

		pending.settled = true;
		pending.graceTimer = clearTimer(pending.graceTimer);
		this.pendingDials.delete(pending.channelId);

		return true;
	}

	/**
	 * The person we rang has picked up: promote the parked dial into a live call.
	 *
	 * The outbound sibling of beginCall, and deliberately as thin as it is - it
	 * reuses createActiveCall and launchProvider rather than reimplementing them, so
	 * an outbound call cannot drift away from an inbound one.
	 */
	private async claimOutboundDial(channel: AsteriskChannel): Promise<void> {
		const pending = this.pendingDials.get(channel.id);

		if (pending === undefined) {
			// An outbound leg with no parked dial: the backend restarted between the
			// originate and the answer, so the purpose of this call is gone. There is
			// nothing honest to say to whoever just answered - an agent with no idea why
			// it rang is exactly what this feature must never produce - so the call is
			// ended rather than improvised.
			logger.error(
				{ channelId: channel.id },
				"an outbound leg entered Stasis with no pending dial; hanging it up"
			);
			await this.quietly("ari.hangup(orphan-outbound)", () =>
				this.ari.hangup(channel.id, "normal")
			);
			return;
		}

		if (!this.settleDial(pending)) {
			return;
		}

		const call = this.createActiveCall({
			callId: pending.callId,
			tenantId: pending.tenantId,
			// An outbound leg never touched a context on its way out, so there is no
			// dialplan statement to read: the campaign's tenant is the answer.
			tenantSlug: await resolveTenantSlug(pending.tenantId, null),
			channel,
			// The person at the far end, which is what every reader of this field wants
			// on both directions - contact matching, the prompt, calls.caller_number.
			callerNumber: pending.phone,
			dialledExtension: null,
			direction: "outbound",
			outbound: {
				campaign: pending.campaign,
				campaignId: pending.campaignId,
				leadId: pending.leadId,
				requestedByUserId: pending.requestedByUserId,
				reportedOutcome: null,
			},
			contact: pending.contact,
			startedAt: pending.startedAt,
		});

		this.calls.set(call.callId, call);
		this.callsByChannel.set(channel.id, call.callId);
		this.broadcast({ type: LIVE_CALL_EVENTS.started, call: this.snapshot(call) }, call);

		logger.info(
			{
				callId: call.callId,
				channelId: channel.id,
				phone: pending.phone,
				campaignId: pending.campaignId,
				leadId: pending.leadId,
				ringSeconds: Math.round((Date.now() - pending.startedAtMs) / 1000),
			},
			"an outbound campaign call was answered"
		);

		try {
			if (channel.state !== "Up") {
				// Normally already answered by the far end - that IS the answer on an
				// originated channel. Guarded rather than assumed, because a channel that
				// somehow reached Stasis un-answered would otherwise get audio it cannot
				// carry.
				await this.ari.answer(channel.id);
			}

			call.answered = true;
			await this.quietly("markCallAnswered", () => markCallAnswered(call.tenantId, call.callId));
			await this.launchProvider(call);
		} catch (cause) {
			await this.abortCall(call, cause);
		}
	}

	/**
	 * A dial that never became a conversation.
	 *
	 * The `calls` row is finalised as "missed" - which is what it is, from the
	 * person's side - and the verdict goes to the dialer so its retry policy can act
	 * on the difference between a busy line and a number that does not exist. A note
	 * records the reason, because a call row with no transcript and no explanation is
	 * the kind of thing an owner reasonably reads as a bug.
	 */
	private async abandonOutboundDial(
		pending: PendingOutboundDial,
		verdict: { outcome: OutboundOutcome; reason: string }
	): Promise<void> {
		if (!this.settleDial(pending)) {
			return;
		}

		const durationSeconds = Math.max(0, Math.round((Date.now() - pending.startedAtMs) / 1000));

		logger.info(
			{
				callId: pending.callId,
				phone: pending.phone,
				outcome: verdict.outcome,
				reason: verdict.reason,
				ringSeconds: durationSeconds,
			},
			"an outbound campaign call was not answered"
		);

		await this.quietly("addNote(outbound-unanswered)", () =>
			addNote(pending.tenantId, {
				callId: pending.callId,
				authorType: "system",
				authorUserId: pending.requestedByUserId,
				content: `Qo'ng'iroq javobsiz yakunlandi: ${verdict.reason}`,
			})
		);

		await this.quietly("markCallEnded(outbound-unanswered)", () =>
			// "missed" of the five existing call_status values: nobody took the call.
			// No enum was added for this - the person missing our call is the same fact
			// as us missing theirs, and it keeps the /calls page filters working.
			markCallEnded(pending.tenantId, pending.callId, { status: "missed", durationSeconds })
		);

		await reportOutboundOutcome({
			callId: pending.callId,
			campaignId: pending.campaignId,
			leadId: pending.leadId,
			phone: pending.phone,
			outcome: verdict.outcome,
			reason: verdict.reason,
			callBackAt: null,
			optOut: false,
			source: "channel",
			durationSeconds,
			at: new Date().toISOString(),
		});

		// No "ended" broadcast: no "started" was ever broadcast for a ringing dial, so
		// the live-calls channel never knew about this call and an orphan ending event
		// would just be noise on the dashboard. The campaign page reads the lead row.
	}

	/**
	 * Build the in-memory record for a call that is about to start talking.
	 *
	 * Takes a spec rather than the four positional arguments it used to, because
	 * the outbound path supplies a different one of nearly every field: the `calls`
	 * row was written minutes ago at dial time, the channel is already answered, and
	 * there is a campaign attached. Everything BELOW the spec is identical for both
	 * directions - that is the point, and it is why an outbound call gets the same
	 * guards, the same cost accounting and the same teardown for free.
	 */
	private createActiveCall(spec: {
		callId: string;
		tenantId: TenantId;
		tenantSlug: string | null;
		channel: AsteriskChannel;
		callerNumber: string;
		dialledExtension: string | null;
		direction: "inbound" | "outbound";
		outbound: OutboundCallState | null;
		contact: LiveCallContact | null;
		startedAt: Date;
	}): ActiveCall {
		return {
			callId: spec.callId,
			tenantId: spec.tenantId,
			tenantSlug: spec.tenantSlug,
			channelId: spec.channel.id,
			channelName: spec.channel.name,
			callerNumber: spec.callerNumber,
			dialledExtension: spec.dialledExtension,
			direction: spec.direction,
			outbound: spec.outbound,
			startedAt: spec.startedAt,
			startedAtMs: spec.startedAt.getTime(),

			contact: spec.contact,
			previousCallCount: 0,
			isReturningCaller: false,
			ticketId: null,

			aiSessionId: null,
			provider: null,
			providerName: null,
			context: null,
			session: null,

			profile: null,

			status: "starting",
			answered: false,
			ready: false,
			greetingSpoken: false,
			handedToDialplan: false,
			usesAudioSocket: false,
			fallbackRecordingPath: null,

			transfer: {
				phase: "none",
				extension: null,
				transferId: null,
				toChannelId: null,
				reason: null,
				failureReason: null,
			},
			operatorUserId: null,

			interim: new Map(),
			promptTokens: 0,
			completionTokens: 0,
			cachedTokens: 0,
			cachedAudioTokens: null,
			cachedTextTokens: null,
			inputAudioTokens: 0,
			inputTextTokens: 0,
			outputAudioTokens: 0,
			outputTextTokens: 0,
			responseTurns: 0,
			transcribeAudioTokens: 0,
			transcribeTextTokens: 0,
			transcribeModel: null,
			lastActivityAt: Date.now(),

			callerVoice: new CallerVoiceActivity(),
			lastCallerSpeechNotifyAt: 0,
			agentStalls: 0,
			callerTranscripts: 0,

			endReason: null,
			closingSpeech: false,
			aiError: null,
			unavailableReason: null,

			aiPathClosed: false,
			finalized: false,

			playbackId: null,
			greetingTimer: null,
			maxDurationTimer: null,
			silenceTimer: null,
			agentStallTimer: null,
			finalizeTimer: null,
		};
	}

	/**
	 * What the agent is told about this caller before the first audio frame.
	 *
	 * History failures are swallowed into an empty history on purpose: not knowing
	 * that somebody called last week is a worse greeting, not a failed call.
	 */
	private async buildSessionContext(
		call: ActiveCall,
		profile: ActiveAgentProfile
	): Promise<VoiceSessionContext> {
		let previousCallCount = 0;
		let recentTickets: VoiceSessionContext["recentTickets"] = [];

		if (call.contact !== null) {
			try {
				const history = await getContactHistory(call.tenantId, call.contact.id, {
					// The `calls` row for THIS call already exists, so it has to be left
					// out or the agent would greet a first-time caller as a returning one.
					excludeCallId: call.callId,
				});
				previousCallCount = history.previousCallCount;
				recentTickets = history.recentTickets;
			} catch (cause) {
				logger.warn(
					{ err: cause, callId: call.callId, contactId: call.contact.id },
					"could not load the caller history; continuing without it"
				);
			}
		}

		call.previousCallCount = previousCallCount;
		call.isReturningCaller = previousCallCount > 0;

		return {
			callId: call.callId,
			channelId: call.channelId,
			callerNumber: call.callerNumber,
			// The business's language, not the deployment's: AI_AGENT_LANGUAGE is only
			// what getActiveAgentProfile() falls back to when nothing is configured.
			language: profile.language,
			contact:
				call.contact === null
					? null
					: {
							id: call.contact.id,
							firstName: call.contact.firstName,
							lastName: call.contact.lastName,
							address: call.contact.address,
						},
			isReturningCaller: previousCallCount > 0,
			previousCallCount,
			recentTickets,
			// The ONE field that turns this into an outbound session: it is what makes
			// buildSystemInstructions add the outbound half of the prompt, buildGreeting
			// compose an opening line from the purpose instead of asking "how can I
			// help", and the providers advertise record_call_outcome. Null on every
			// inbound call, so all three behave exactly as they did before.
			campaign: call.outbound?.campaign ?? null,
		};
	}

	/**
	 * Who the agent is on this call, and what it is allowed to say.
	 *
	 * Read once per call and then carried on the ActiveCall record: the prompt, the
	 * greeting, the session voice, the guard timers and the knowledge lookups all
	 * have to describe the same business, and re-reading mid-call could hand a
	 * caller two different identities if the owner saved an edit while they were on
	 * the line.
	 *
	 * Neither call can throw in practice - getActiveAgentProfile() falls back to
	 * cautious defaults and getPrimedEntries() to an empty list - but both are
	 * guarded anyway: a phone that is not answered is a worse failure than an agent
	 * that knows nothing.
	 */
	private async loadAgentSetup(call: ActiveCall): Promise<VoiceProviderSetup> {
		let profile: ActiveAgentProfile;

		try {
			profile = await getActiveAgentProfile(call.tenantId);
		} catch (cause) {
			logger.error(
				{ err: cause, callId: call.callId },
				"could not load the AI agent profile; answering with cautious defaults"
			);
			profile = unconfiguredAgentProfile();
		}

		let knowledge: KnowledgeHit[] = [];

		if (profile.id !== null) {
			try {
				knowledge = await getPrimedEntries(call.tenantId, profile.id, PRIMED_KNOWLEDGE_LIMIT);
			} catch (cause) {
				logger.error(
					{ err: cause, callId: call.callId, profileId: profile.id },
					"could not load the primed knowledge entries; the agent will look answers up instead"
				);
			}
		}

		logger.info(
			{
				callId: call.callId,
				profileId: profile.id,
				business: profile.businessName,
				configured: profile.isConfigured,
				language: profile.language,
				voice: profile.voice,
				unknownPolicy: profile.unknownPolicy,
				knowledgeEntries: knowledge.length,
			},
			"agent profile resolved for the call"
		);

		return { tenantId: call.tenantId, profile, knowledge };
	}

	/**
	 * Resolve a provider, write the ai_sessions row, start the session, and only
	 * then hand the channel to [ai-bridge].
	 *
	 * The order matters: while the channel is still in Stasis we can play prompts,
	 * start MoH and build a bridge, so a provider that fails to start can be
	 * degraded to the IVR fallback with the caller still under our control. Once
	 * the channel is executing AudioSocket() in the dialplan, ARI answers 409 for
	 * all three and the only way out is an AMI redirect.
	 */
	private async launchProvider(call: ActiveCall): Promise<void> {
		const env = getServerEnv();
		// The one await that makes the AI settings page real: the stored values are
		// re-read here, before a provider is built and before the profile defaults
		// are computed from them, so a change made a minute ago serves this caller.
		const ai = await this.resolveAiSettings(call.tenantId);
		const { profile, knowledge } = await this.loadAgentSetup(call);

		call.profile = profile;

		const context = await this.buildSessionContext(call, profile);
		call.context = context;

		let provider: VoiceProvider;

		try {
			provider = await this.providerFactory({ tenantId: call.tenantId, profile, knowledge });
		} catch (cause) {
			logger.error(
				{ err: cause, callId: call.callId },
				"the provider factory threw; using the IVR fallback"
			);
			provider = createFallbackIvrProvider();
		}

		call.provider = provider;
		call.providerName = provider.name;

		const realtime = provider.name !== FALLBACK_IVR_PROVIDER_NAME;
		// The voice the business chose, so the ai_sessions row says what the caller
		// actually heard rather than what .env happens to hold. Same precedence the
		// provider itself applies - including the configured fallback rather than the
		// boot-time environment, which is what the page can change.
		const sessionVoice = profile.isConfigured
			? profile.voice
			: ai.provider === "gemini"
				? ai.geminiVoice
				: ai.openaiVoice;
		// The provider's own model id when it reports one. Without that, a Gemini
		// call is labelled with the OpenAI model and every per-model cost figure
		// prices Gemini traffic at OpenAI rates.
		const sessionModel = provider.model ?? (realtime ? ai.openaiModel : null);
		const session = await createAiSession(call.tenantId, {
			callId: call.callId,
			channelId: call.channelId,
			provider: provider.name,
			model: realtime ? sessionModel : null,
			voice: realtime ? sessionVoice : null,
			language: profile.language,
			metadata: {
				callerNumber: call.callerNumber,
				dialledExtension: call.dialledExtension,
				channelName: call.channelName,
				ariApp: env.ASTERISK_ARI_APP,
				agentProfileId: profile.id,
				businessName: profile.businessName,
				knowledgeEntries: knowledge.length,
			},
		});
		call.aiSessionId = session.id;

		if (!realtime) {
			// resolveVoiceProvider already decided there is no realtime backend (AI
			// switched off, or no API key). Nothing threw, so this is a configured
			// state rather than a failure - but there is still no AI on this call.
			call.unavailableReason =
				"no realtime voice provider is available (AI_AGENT_ENABLED / OPENAI_API_KEY), so the call was handled by the IVR fallback";
			await this.runFallbackPath(call, provider, context);
			return;
		}

		try {
			await provider.start(context, this.buildProviderHandlers(call));
		} catch (cause) {
			await this.degradeToFallback(call, context, cause);
			return;
		}

		await this.handToBridge(call, env.AUDIOSOCKET_ADVERTISE_HOST);
	}

	private async handToBridge(call: ActiveCall, advertiseHost: string): Promise<void> {
		// AS_UUID is calls.id: that is what makes the inbound AudioSocket connection
		// resolve to a CRM record with no extra lookup.
		await this.ari.setVariable(call.channelId, "AS_UUID", call.callId);
		await this.ari.setVariable(call.channelId, "AS_HOST", advertiseHost);

		// The bridge context is this customer's own, and the MixMonitor line inside it
		// writes into this customer's own directory - so the directory has to be there
		// before the channel gets there.
		const bridgeContext = tenantContextsFor(call.tenantSlug).aiBridge;

		if (call.tenantSlug !== null) {
			await ensureTenantRecordingDir(call.tenantSlug);
		}

		// Flag the intent *before* asking for the handover, not after.
		//
		// StasisEnd arrives on the ARI event socket, which is a different connection
		// from the REST call below, so the event can and does beat the HTTP response.
		// When it did, handleStasisEnd saw handedToDialplan=false and read our own
		// handover as the caller abandoning the call: a live call was finalised after
		// 2 s, with its AudioSocket connection attaching 7 ms later to a call the
		// orchestrator had already written off.
		const previousStatus = call.status;

		call.handedToDialplan = true;
		call.usesAudioSocket = true;
		call.status = "live";

		try {
			await this.ari.continueInDialplan(call.channelId, {
				context: bridgeContext,
				extension: BRIDGE_EXTENSION,
			});
		} catch (cause) {
			// The channel never left Stasis, so restore the pre-handover view and let
			// the caller's error path decide what happens next.
			call.handedToDialplan = false;
			call.usesAudioSocket = false;
			call.status = previousStatus;
			throw cause;
		}

		const aiSessionId = call.aiSessionId;

		if (aiSessionId !== null) {
			// The row was written before start(), so its voice was a prediction. Only
			// the provider knows which voice it settled on - it reconciles the profile,
			// the stored setting, and its own fallback for a name the vendor rejects.
			// Correcting it here keeps ai_sessions describing the call that happened
			// rather than the one that was intended.
			const spokenVoice = call.provider?.voice;

			await this.quietly("updateAiSession(active)", () =>
				updateAiSession(call.tenantId, aiSessionId, {
					status: "active",
					...(spokenVoice === undefined ? {} : { voice: spokenVoice }),
				})
			);
		}

		this.armTimers(call);
		this.broadcast({ type: LIVE_CALL_EVENTS.updated, call: this.snapshot(call) }, call);

		logger.info(
			{ callId: call.callId, channelId: call.channelId, provider: call.providerName },
			"channel handed to the AudioSocket bridge"
		);
	}

	/**
	 * The realtime provider could not open a session. Swap in the IVR fallback
	 * rather than inventing a second handover path: the fallback asks for a human
	 * through the same transfer_to_human tool the AI would have used.
	 */
	private async degradeToFallback(
		call: ActiveCall,
		context: VoiceSessionContext,
		cause: unknown
	): Promise<void> {
		const message = describeError(cause);
		const expected = cause instanceof VoiceProviderUnavailableError;

		if (expected) {
			logger.warn(
				{ callId: call.callId, provider: call.providerName, detail: message },
				"the voice provider is unavailable; falling back to the IVR path"
			);
		} else {
			logger.error(
				{ err: cause, callId: call.callId, provider: call.providerName },
				"the voice provider failed to start; falling back to the IVR path"
			);
		}

		call.aiError = message;
		call.unavailableReason = message;

		const aiSessionId = call.aiSessionId;

		if (aiSessionId !== null) {
			// The provider column keeps naming what we tried; the error message is
			// what explains why the caller never spoke to it.
			await this.quietly("updateAiSession(error)", () =>
				updateAiSession(call.tenantId, aiSessionId, { errorMessage: message })
			);
		}

		await this.quietly("appendTranscript(system)", () =>
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: "system",
				content: `AI ovozli yordamchi ishga tushmadi (${message}). Qo'ng'iroq operatorga uzatiladi.`,
				startMs: this.elapsedMs(call),
				endMs: this.elapsedMs(call),
			})
		);

		const fallback = createFallbackIvrProvider({ transferReason: FALLBACK_TRANSFER_REASON });
		call.provider = fallback;
		call.providerName = fallback.name;

		await this.runFallbackPath(call, fallback, context);
	}

	/**
	 * Fallback path: the channel stays in Stasis (so ARI can talk to it), the
	 * caller hears an Asterisk prompt, and the fallback provider raises
	 * transfer_to_human a moment later - which lands in the same tool executor the
	 * AI uses, so there is no second handover implementation.
	 */
	private async runFallbackPath(
		call: ActiveCall,
		provider: VoiceProvider,
		context: VoiceSessionContext
	): Promise<void> {
		call.usesAudioSocket = false;
		call.status = "live";

		// MixMonitor lives in [ai-bridge], which this path never reaches, so start
		// it over AMI instead.
		//
		// AMI MixMonitor and NOT ARI's own /channels/{id}/record: a channel with an
		// ARI live recording attached cannot be added to a bridge - Asterisk answers
		// "409 Channel currently recording" - which silently broke the human
		// transfer this very path depends on. MixMonitor is an audiohook, so it
		// keeps recording straight through the transfer bridge and captures the
		// operator's half of the conversation too.
		//
		// The absolute path matters: a bare filename would land in
		// /var/spool/asterisk/monitor, which is not the bind-mounted directory.
		await this.quietly("ami.MixMonitor", async () => {
			const filePath = recordingPathFor(call.callId, call.tenantSlug);

			// MixMonitor will not create the tenant directory for us on every build, and a
			// recording that lands nowhere is indistinguishable from a call nobody kept.
			if (call.tenantSlug !== null) {
				await ensureTenantRecordingDir(call.tenantSlug);
			}

			await getAmiClient().action("MixMonitor", {
				Channel: call.channelName,
				File: filePath,
			});
			call.fallbackRecordingPath = filePath;
		});

		const aiSessionId = call.aiSessionId;

		if (aiSessionId !== null) {
			await this.quietly("updateAiSession(active)", () =>
				updateAiSession(call.tenantId, aiSessionId, { status: "active" })
			);
		}

		// Never throws by construction, but a bug here must not drop the call.
		await this.quietly("fallback provider start", () =>
			provider.start(context, this.buildProviderHandlers(call))
		);

		this.armTimers(call);
		this.broadcast({ type: LIVE_CALL_EVENTS.updated, call: this.snapshot(call) }, call);

		// Not awaited: the provider asks for a human ~1.5 s from now, and
		// startTransfer stops whatever is playing before it starts MoH.
		this.track(this.playPrompt(call, FALLBACK_PROMPT_MEDIA), `fallback prompt ${call.callId}`);
	}

	/** Setup blew up after the call row existed: tell the caller nothing, but close cleanly. */
	private async abortCall(call: ActiveCall, cause: unknown): Promise<void> {
		const message = describeError(cause);

		logger.error({ err: cause, callId: call.callId }, "call setup failed");
		call.aiError = message;
		call.unavailableReason = message;
		call.endReason = "setup-failed";

		await this.quietly("ari.hangup", () => this.ari.hangup(call.channelId, "congestion"));
		await this.finalizeCall(call, { reason: "setup-failed" });
	}

	// -----------------------------------------
	// AudioSocket
	// -----------------------------------------

	private attachAudioSocketSession(session: AudioSocketSession): void {
		const call = this.calls.get(session.uuid);

		if (call === undefined) {
			// The UUID is calls.id, so an unknown one means the call is already gone
			// (or the connection is not ours). Holding the socket open would be dead
			// air, so it is closed immediately.
			logger.warn(
				{ uuid: session.uuid, remote: session.remoteAddress },
				"AudioSocket connection for an unknown call; closing it"
			);
			session.hangup();
			return;
		}

		if (call.session !== null) {
			logger.warn({ callId: call.callId }, "second AudioSocket connection for one call; replacing");
		}

		call.session = session;
		call.usesAudioSocket = true;
		this.touchActivity(call);

		session.onAudio((chunk: Buffer) => {
			// Measure the caller's own channel on the way past. This is the guards' only
			// evidence that is not the provider's word for it: frames arrive 50 times a
			// second whether or not anybody is speaking, so their level is the only
			// thing that separates a quiet line from a deaf model.
			if (call.callerVoice.push(chunk)) {
				this.noteCallerSpeech(call);
			}

			call.provider?.pushAudio(chunk);
		});

		session.onDtmf((digit: string) => {
			this.handleDtmf(call, digit);
		});

		session.onError((error) => {
			logger.error(
				{ err: error, kind: error.kind, callId: call.callId },
				"AudioSocket session error"
			);
		});

		session.onEnd(() => {
			this.track(this.handleAudioSocketEnd(call), `audiosocket end ${call.callId}`);
		});

		logger.info(
			{ callId: call.callId, remote: session.remoteAddress },
			"AudioSocket session attached to the call"
		);

		this.maybeSpeakGreeting(call);
	}

	private async handleAudioSocketEnd(call: ActiveCall): Promise<void> {
		logger.info(
			{
				callId: call.callId,
				stats: call.session?.stats() ?? null,
				// Every half of the "was anybody there?" question in one line: what
				// Asterisk delivered, how much of it was a voice, and how loud the line
				// underneath it was.
				callerAudio: call.callerVoice.stats(),
				agentStalls: call.agentStalls,
			},
			"AudioSocket session ended"
		);

		if (call.transfer.phase === "requested" || call.transfer.phase === "connected") {
			// The AMI redirect pulled the channel out of AudioSocket(); the caller is
			// ringing or already talking to a human, so the call row stays open.
			await this.endAiPath(call, { reason: "transferred" });
			return;
		}

		await this.endAiPath(call, { reason: "audiosocket-end" });
		// [ai-bridge] hangs the channel up once AudioSocket() returns, so the call
		// really is over. ChannelDestroyed normally gets here first; both are safe.
		await this.finalizeCall(call, { reason: "audiosocket-end" });
	}

	private handleDtmf(call: ActiveCall, digit: string): void {
		this.touchActivity(call);
		logger.info({ callId: call.callId, digit }, "DTMF from the caller");

		this.track(
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: "system",
				content: `Fuqaro "${digit}" tugmasini bosdi.`,
				startMs: this.elapsedMs(call),
				endMs: this.elapsedMs(call),
			}),
			`dtmf transcript ${call.callId}`
		);

		if (digit === "0" && call.transfer.phase === "none") {
			// The universal "get me a person" gesture; honouring it costs nothing and
			// stops a caller who cannot be understood from being stuck with the bot.
			this.track(
				this.startTransfer(call, { reason: "caller pressed 0 to reach an operator" }),
				`dtmf transfer ${call.callId}`
			);
		}
	}

	// -----------------------------------------
	// Provider handlers
	// -----------------------------------------

	private buildProviderHandlers(call: ActiveCall): VoiceProviderHandlers {
		return {
			onReady: () => {
				call.ready = true;
				this.touchActivity(call);
				logger.info({ callId: call.callId, provider: call.providerName }, "voice session is ready");
				this.maybeSpeakGreeting(call);
			},
			onAudio: (slin8k: Buffer) => {
				this.sendAgentAudio(call, slin8k);
			},
			onTranscript: (transcript) => {
				this.handleTranscript(call, transcript);
			},
			onToolCall: async (request) => await this.handleToolCall(call, request),
			// Whatever the provider's own server heard. OpenAI reports this mid-turn
			// from its VAD, Gemini only at the end of a turn; neither is depended on,
			// because the platform measures the caller's frames itself. Both are still
			// honoured - a signal that is true is worth acting on.
			onCallerSpeech: () => {
				this.noteCallerSpeech(call);
			},
			onInterruption: () => {
				this.touchActivity(call);

				// The farewell is not interruptible: the call is already ending, and
				// VAD fires on line noise as readily as on speech. Dropping it here
				// would cut the goodbye off for no benefit - there is no further turn
				// for the caller to win.
				if (call.closingSpeech) {
					return;
				}

				// Barge-in: cancelling the model's response upstream is not enough on
				// its own. The AudioSocket queue holds a whole already-generated
				// utterance (a speech-to-speech model emits ~7 s of audio in ~2 s), so
				// without this the agent keeps talking over the caller for seconds
				// after they interrupted.
				const dropped = call.session?.discardQueuedAudio() ?? 0;

				if (dropped > 0) {
					logger.debug(
						{ callId: call.callId, droppedFrames: dropped },
						"barge-in: discarded queued agent audio"
					);
				}
			},
			onUsage: (usage) => {
				const completion = usage.completionTokens ?? 0;

				call.promptTokens += usage.promptTokens ?? 0;
				call.completionTokens += completion;
				call.cachedTokens += usage.cachedTokens ?? 0;

				// Only accumulated once the provider has reported it at least once, so
				// a provider that never does leaves null rather than a measured zero.
				if (usage.cachedAudioTokens !== undefined) {
					call.cachedAudioTokens = (call.cachedAudioTokens ?? 0) + usage.cachedAudioTokens;
				}
				if (usage.cachedTextTokens !== undefined) {
					call.cachedTextTokens = (call.cachedTextTokens ?? 0) + usage.cachedTextTokens;
				}

				call.inputAudioTokens += usage.inputAudioTokens ?? 0;
				call.inputTextTokens += usage.inputTextTokens ?? 0;
				call.outputAudioTokens += usage.outputAudioTokens ?? 0;
				call.outputTextTokens += usage.outputTextTokens ?? 0;

				// Only turns that actually produced something. A response cancelled by a
				// barge-in still reports usage, with zero output - counting it would
				// inflate the turn count with turns nobody heard and nobody paid for,
				// and the turn count is what the per-turn cost figures divide by.
				if (completion > 0) {
					call.responseTurns += 1;
				}
			},
			onTranscriptionUsage: (usage) => {
				call.transcribeAudioTokens += usage.audioTokens ?? 0;
				call.transcribeTextTokens += usage.textTokens ?? 0;

				if (usage.model !== undefined && usage.model.length > 0) {
					call.transcribeModel = usage.model;
				}
			},
			onError: (error) => {
				logger.error({ err: error, callId: call.callId }, "voice provider error");
				call.aiError = error.message;

				if (call.aiSessionId !== null) {
					this.track(
						updateAiSession(call.tenantId, call.aiSessionId, { errorMessage: error.message }),
						`session error ${call.callId}`
					);
				}
			},
			onClose: (reason) => {
				this.track(this.handleProviderClose(call, reason), `provider close ${call.callId}`);
			},
		};
	}

	/**
	 * The provider hung up on us. If a transfer is in flight the human leg carries
	 * on; otherwise the caller has nobody to talk to and must be released rather
	 * than left listening to nothing.
	 */
	private async handleProviderClose(call: ActiveCall, reason: string): Promise<void> {
		if (call.aiPathClosed || call.finalized) {
			return;
		}

		logger.info({ callId: call.callId, reason }, "voice provider closed the session");

		if (call.transfer.phase === "requested" || call.transfer.phase === "connected") {
			await this.endAiPath(call, { reason: `provider-closed:${reason}` });
			return;
		}

		await this.hangupCall(call.tenantId, call.callId, `provider-closed:${reason}`);
	}

	private maybeSpeakGreeting(call: ActiveCall): void {
		if (
			call.greetingSpoken ||
			!call.ready ||
			call.context === null ||
			call.provider === null ||
			// Set together with the context in launchProvider; both or neither.
			call.profile === null
		) {
			return;
		}

		if (call.providerName === FALLBACK_IVR_PROVIDER_NAME) {
			// No model produces audio on this path; the ARI prompt is the greeting.
			return;
		}

		if (call.usesAudioSocket && call.session === null) {
			// Speaking before Asterisk has dialled in would generate audio with
			// nowhere to send it, and the caller would miss the greeting entirely.
			return;
		}

		call.greetingSpoken = true;
		const provider = call.provider;
		// The business's own greeting when it configured one, and its own recording
		// notice and after-hours line when they apply.
		const text = buildGreeting(call.context, call.profile);

		call.greetingTimer = setTimeout(() => {
			call.greetingTimer = null;

			if (call.aiPathClosed) {
				return;
			}

			// The most-heard line on the whole system, and a fixed string: worth the
			// best voice available, and it costs nothing after the first render.
			this.track(
				this.speakFixedLine(call, text).then((spoken) => {
					if (!(spoken || call.aiPathClosed)) {
						provider.say(text);
					}
				}),
				`greeting ${call.callId}`
			);
		}, this.greetingDelayOverrideMs ?? configuredGreetingDelayMs(call.tenantId));
	}

	// -----------------------------------------
	// Transcripts
	// -----------------------------------------

	private handleTranscript(
		call: ActiveCall,
		transcript: {
			role: TranscriptRole;
			content: string;
			isFinal: boolean;
			startMs?: number;
			endMs?: number;
		}
	): void {
		this.touchActivity(call);

		if (transcript.role === "caller" && transcript.isFinal) {
			call.callerTranscripts += 1;
		}

		if (transcript.isFinal) {
			this.handleFinalTranscript(call, transcript);
			return;
		}

		// Deltas are token fragments, so they are NOT trimmed - trimming each one
		// would glue words together.
		if (transcript.content.length === 0) {
			return;
		}

		const now = Date.now();
		const buffer = call.interim.get(transcript.role) ?? {
			text: "",
			startMs: transcript.startMs ?? null,
			// Deliberately "now": the DB write is delayed one interval so a short
			// utterance produces only its final row.
			lastWriteAt: now,
			lastBroadcastAt: 0,
		};

		buffer.text = `${buffer.text}${transcript.content}`.slice(0, INTERIM_MAX_CHARS);
		call.interim.set(transcript.role, buffer);

		const partial = buffer.text.trim();

		if (partial.length === 0) {
			return;
		}

		if (now - buffer.lastBroadcastAt >= INTERIM_BROADCAST_MIN_INTERVAL_MS) {
			buffer.lastBroadcastAt = now;
			this.broadcastTranscript(call, {
				role: transcript.role,
				content: partial,
				isFinal: false,
				startMs: buffer.startMs,
				endMs: null,
			});
		}

		if (now - buffer.lastWriteAt >= INTERIM_WRITE_MIN_INTERVAL_MS) {
			buffer.lastWriteAt = now;
			this.track(
				appendTranscript(call.tenantId, {
					callId: call.callId,
					aiSessionId: call.aiSessionId,
					role: transcript.role,
					content: partial,
					isFinal: false,
					startMs: buffer.startMs,
					endMs: null,
				}),
				`interim transcript ${call.callId}`
			);
		}
	}

	private handleFinalTranscript(
		call: ActiveCall,
		transcript: {
			role: TranscriptRole;
			content: string;
			isFinal: boolean;
			startMs?: number;
			endMs?: number;
		}
	): void {
		const buffer = call.interim.get(transcript.role);
		call.interim.delete(transcript.role);

		const content = transcript.content.trim();

		if (content.length === 0) {
			return;
		}

		const startMs = transcript.startMs ?? buffer?.startMs ?? null;
		const endMs = transcript.endMs ?? this.elapsedMs(call);

		this.broadcastTranscript(call, {
			role: transcript.role,
			content,
			isFinal: true,
			startMs,
			endMs,
		});

		this.track(
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: transcript.role,
				content,
				isFinal: true,
				startMs,
				endMs,
			}),
			`final transcript ${call.callId}`
		);
	}

	// -----------------------------------------
	// Tool calls
	// -----------------------------------------

	/**
	 * Validate and execute one tool call.
	 *
	 * Always resolves to a plain object the model can speak from - a bad name, bad
	 * arguments or a failed write all come back as `{ ok: false, error }`. Nothing
	 * is ever thrown back into the provider, because a thrown tool handler would
	 * leave the caller mid-sentence with no answer.
	 */
	private async handleToolCall(
		call: ActiveCall,
		request: { name: string; toolCallId: string; args: Record<string, unknown> }
	): Promise<unknown> {
		const validated = validateToolArguments(request.name, request.args);

		if (!validated.ok) {
			logger.warn(
				{ callId: call.callId, tool: request.name, detail: validated.error },
				"rejected a tool call"
			);
			return { ok: false, error: validated.error };
		}

		this.touchActivity(call);

		try {
			// `validated.args` is typed `unknown` because TOOL_VALIDATORS is a map of
			// heterogeneous schemas; the cast per branch is the narrowing zod already
			// performed at runtime.
			switch (validated.name) {
				case "search_knowledge_base":
					return await this.toolSearchKnowledgeBase(
						call,
						validated.args as SearchKnowledgeBaseArgs
					);
				case "save_contact_details":
					return await this.toolSaveContactDetails(call, validated.args as SaveContactDetailsArgs);
				case "create_ticket":
					return await this.toolCreateTicket(call, validated.args as CreateTicketArgs);
				case "add_note":
					return await this.toolAddNote(call, validated.args as AddNoteArgs);
				case "create_follow_up":
					return await this.toolCreateFollowUp(call, validated.args as CreateFollowUpArgs);
				case "book_appointment":
					return await this.toolBookAppointment(call, validated.args as BookAppointmentArgs);
				case "transfer_to_human":
					return await this.toolTransferToHuman(call, validated.args as TransferToHumanArgs);
				case "record_call_outcome":
					return await this.toolRecordCallOutcome(call, validated.args as RecordCallOutcomeArgs);
				case "end_call":
					return this.toolEndCall(call, validated.args as EndCallArgs);
				default:
					// Unreachable: validateToolArguments only returns known names.
					return { ok: false, error: `tool "${request.name}" has no handler` };
			}
		} catch (cause) {
			const message = describeError(cause);
			logger.error({ err: cause, callId: call.callId, tool: validated.name }, "tool call failed");
			return { ok: false, error: message };
		}
	}

	/**
	 * Answer a business question from the business's own knowledge base.
	 *
	 * This is the tool that keeps the agent honest, so an empty result is NOT a
	 * failure: it comes back `ok: true, found: false` carrying the profile's own
	 * unknown-answer policy as the instruction to follow. Returning `ok: false`
	 * here would read to the model as "the lookup broke, try to cope", which is
	 * exactly the moment a model invents a price.
	 */
	private async toolSearchKnowledgeBase(
		call: ActiveCall,
		args: SearchKnowledgeBaseArgs
	): Promise<unknown> {
		const profile = call.profile ?? unconfiguredAgentProfile();

		if (profile.id === null) {
			// No profile row at all: there is no knowledge base to search, and saying so
			// plainly is what stops the model filling the gap itself.
			return {
				ok: true,
				found: false,
				entries: [],
				message: buildKnowledgeMissGuidance(profile),
			};
		}

		const hits = await searchKnowledgeBase(
			call.tenantId,
			profile.id,
			args.query,
			KNOWLEDGE_SEARCH_LIMIT
		);

		logger.info(
			{ callId: call.callId, query: args.query, hits: hits.length },
			"knowledge base lookup for a caller question"
		);

		if (hits.length === 0) {
			return {
				ok: true,
				found: false,
				entries: [],
				message: buildKnowledgeMissGuidance(profile),
			};
		}

		return {
			ok: true,
			found: true,
			entries: hits.map((hit) => ({ question: hit.question, answer: hit.answer })),
			message:
				"These are the business's own answers. You may state them, in the language of " +
				"the call, in one or two short sentences. Anything they do not cover you still " +
				"do not know.",
		};
	}

	private async toolSaveContactDetails(
		call: ActiveCall,
		args: SaveContactDetailsArgs
	): Promise<unknown> {
		if (call.contact === null && args.altPhone !== undefined) {
			// Withheld caller id: the number the caller dictates is the only key we
			// will ever have for them, so it becomes their contact.
			const resolved = await findOrCreateContact(call.tenantId, args.altPhone);
			await setCallContact(call.tenantId, call.callId, resolved.contact.id);

			call.contact = {
				id: resolved.contact.id,
				firstName: resolved.contact.firstName,
				lastName: resolved.contact.lastName,
				contactName: contactName(resolved.contact.firstName, resolved.contact.lastName),
				address: resolved.contact.address,
			};
		}

		if (call.contact === null) {
			return {
				ok: false,
				error:
					"this call has no caller id, so there is no contact record yet - ask the caller for a callback number and send it as altPhone",
			};
		}

		const result = await upsertContactDetails(call.tenantId, call.contact.id, {
			firstName: args.firstName ?? null,
			lastName: args.lastName ?? null,
			tuman: args.tuman ?? null,
			kocha: args.kocha ?? null,
			uy: args.uy ?? null,
		});

		call.contact = {
			...call.contact,
			firstName: args.firstName ?? call.contact.firstName,
			lastName: args.lastName ?? call.contact.lastName,
			contactName: contactName(
				args.firstName ?? call.contact.firstName,
				args.lastName ?? call.contact.lastName
			),
			address: result.address,
		};

		if (args.altPhone !== undefined && args.altPhone.replace(/\D/g, "") !== call.callerNumber) {
			// contacts.phone_number is the identity key (and uniquely indexed), so an
			// alternative number is recorded as a note instead of re-keying the row.
			await addNote(call.tenantId, {
				callId: call.callId,
				ticketId: call.ticketId,
				authorType: "ai",
				content: `Qo'shimcha aloqa raqami: ${args.altPhone}`,
			});
		}

		this.broadcast({ type: LIVE_CALL_EVENTS.updated, call: this.snapshot(call) }, call);

		return {
			ok: true,
			saved: {
				firstName: call.contact.firstName,
				lastName: call.contact.lastName,
				address: call.contact.address,
			},
			message: "The caller's details are saved. Do not read them back digit by digit.",
		};
	}

	private async toolCreateTicket(call: ActiveCall, args: CreateTicketArgs): Promise<unknown> {
		if (call.contact === null) {
			return {
				ok: false,
				error:
					"a ticket needs a contact and this call has no caller id - ask for a callback number and send it through save_contact_details first",
			};
		}

		// The categories belong to the business, so this check happens here, against
		// the profile loaded for THIS call, rather than in a zod enum that would need
		// a redeploy every time a customer renamed one. The model is told the list it
		// may choose from, so it can correct itself on the next turn.
		const allowed = call.profile?.ticketCategories ?? FALLBACK_TICKET_CATEGORIES;
		const category = resolveTicketCategory(args.category, allowed);

		if (category === null) {
			const options = normaliseTicketCategories([...allowed]);

			logger.warn(
				{ callId: call.callId, category: args.category, allowed: options },
				"the model sent a category this business does not have"
			);

			return {
				ok: false,
				error: `"${args.category}" is not one of this business's categories`,
				message: `Call create_ticket again with the category spelled exactly as one of: ${options.join(", ")}. Do not mention any of this to the caller.`,
			};
		}

		const result = await createTicketFromCall(call.tenantId, {
			callId: call.callId,
			contactId: call.contact.id,
			subject: args.subject,
			description: args.description,
			category,
			priority: args.priority,
		});

		call.ticketId = result.ticketId;
		this.broadcast({ type: LIVE_CALL_EVENTS.updated, call: this.snapshot(call) }, call);

		return {
			ok: true,
			created: result.created,
			message: result.created
				? "The request is registered. Tell the caller it has been recorded, without any reference number."
				: "This call already had a request registered; nothing was duplicated.",
		};
	}

	private async toolAddNote(call: ActiveCall, args: AddNoteArgs): Promise<unknown> {
		await addNote(call.tenantId, {
			callId: call.callId,
			ticketId: call.ticketId,
			authorType: "ai",
			content: args.content,
		});

		return { ok: true, message: "The note is attached to the call for the operator." };
	}

	private async toolCreateFollowUp(call: ActiveCall, args: CreateFollowUpArgs): Promise<unknown> {
		const result = await createFollowUp(call.tenantId, {
			callId: call.callId,
			ticketId: call.ticketId,
			contactId: call.contact?.id ?? null,
			title: args.title,
			description: args.description ?? null,
			dueAt: args.dueAt === undefined ? null : new Date(args.dueAt),
			createdBySystem: true,
		});

		return {
			ok: true,
			dueAt: result.dueAt === null ? null : result.dueAt.toISOString(),
			message:
				"A callback task is created for a colleague. Do not promise the caller an exact time.",
		};
	}

	private async toolBookAppointment(call: ActiveCall, args: BookAppointmentArgs): Promise<unknown> {
		if (call.contact === null) {
			return {
				ok: false,
				error:
					"a booking needs a contact and this call has no caller id - collect a callback number through save_contact_details first",
			};
		}

		const result = await createBooking(call.tenantId, {
			contactId: call.contact.id,
			callId: call.callId,
			ticketId: call.ticketId,
			title: args.title,
			notes: args.notes ?? null,
			scheduledAt: new Date(args.scheduledAt),
			durationMinutes: args.durationMinutes,
			location: args.location ?? null,
			createdBySystem: true,
		});

		return {
			ok: true,
			scheduledAt: result.scheduledAt.toISOString(),
			message: "The appointment is booked. Confirm the date and time back to the caller once.",
		};
	}

	private async toolTransferToHuman(call: ActiveCall, args: TransferToHumanArgs): Promise<unknown> {
		// Before the caller's audio path changes under them, not after.
		await this.announceBeforeAction(
			call,
			transferAnnouncement(this.callLanguage(call)),
			TRANSFER_ANNOUNCE_MAX_WAIT_MS
		);

		const outcome = await this.startTransfer(call, {
			reason: args.reason,
			preferredExtension: this.resolveTransferPreference(call, args.preferredExtension ?? null),
		});

		if (outcome.alreadyInProgress) {
			return {
				ok: true,
				transferred: outcome.connected,
				message: "A transfer is already under way; say nothing further about it.",
			};
		}

		if (outcome.connected) {
			return {
				ok: true,
				transferred: true,
				extension: outcome.extension,
				message: "The caller is connected to a human operator now. Stop speaking.",
			};
		}

		if (!outcome.callerRetained) {
			return {
				ok: false,
				transferred: false,
				error: `the transfer did not connect (${outcome.failureReason ?? "unknown"})`,
				message: "The caller has been handed to the dialplan. Stop speaking.",
			};
		}

		return {
			ok: false,
			transferred: false,
			error: `no operator could be reached (${outcome.failureReason ?? "unknown"})`,
			message:
				"Tell the caller that no operator is free at the moment, apologise briefly, and offer to register their request instead.",
		};
	}

	/**
	 * What the person actually said, recorded the moment they said it.
	 *
	 * WRITTEN THROUGH IMMEDIATELY, not buffered until the call ends. "Meni ro'yxatdan
	 * chiqaring" is followed by a hung-up phone far more often than by a goodbye, and
	 * an opt-out that only reached the database on a graceful teardown would lose
	 * exactly the refusals that matter most. So the order here is: the do-not-call
	 * list first, then the transcript and the note, then the dialer - each awaited,
	 * and each independently survivable.
	 *
	 * The write also lands in three places on purpose. The do-not-call list is what
	 * makes the promise true; the transcript line is what makes it VISIBLE on the
	 * /calls/:id card next to the recording, which is where somebody investigating a
	 * complaint will look; and the outcome event is what the campaign page counts.
	 */
	private async toolRecordCallOutcome(
		call: ActiveCall,
		args: RecordCallOutcomeArgs
	): Promise<unknown> {
		const outbound = call.outbound;

		if (outbound === null) {
			// Defensive: the tool is not advertised on an inbound call, so a model can
			// only reach this by inventing it. Nothing can act on an outcome with no
			// campaign behind it, and saying so is better than a silent success.
			return {
				ok: false,
				error: "record_call_outcome is only available on outbound campaign calls",
				message: "Do not use this tool on this call.",
			};
		}

		const optOut = args.outcome === "opt_out";
		const at = new Date().toISOString();
		const durationSeconds = Math.max(0, Math.round(this.elapsedMs(call) / 1000));

		if (outbound.reportedOutcome !== null && !optOut) {
			// One outcome per call. The single exception is an opt_out arriving after
			// something milder, because "actually, never call me again" is a new and
			// stronger instruction rather than a correction.
			logger.info(
				{
					callId: call.callId,
					already: outbound.reportedOutcome,
					ignored: args.outcome,
				},
				"ignoring a second outbound outcome"
			);

			return {
				ok: true,
				message: "The outcome for this call is already recorded. Do not record another one.",
			};
		}

		let optOutStored = false;

		if (optOut) {
			optOutStored = await reportOutboundOptOut({
				tenantId: call.tenantId,
				phone: call.callerNumber,
				reason: args.reason,
				callId: call.callId,
				campaignId: outbound.campaignId,
				leadId: outbound.leadId,
				at,
			});
		}

		outbound.reportedOutcome = args.outcome;

		// A "system" transcript line rather than a note alone: it is timestamped into
		// the conversation, so whoever reads the transcript sees the refusal at the
		// point in the call where it was said, not as a detached footnote.
		await this.quietly("appendTranscript(outcome)", () =>
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: "system",
				content: `Natija: ${args.outcome} — ${args.reason}${
					args.callBackAt === undefined ? "" : ` (qayta qo'ng'iroq: ${args.callBackAt})`
				}${optOut ? (optOutStored ? " [ro'yxatdan chiqarildi]" : " [RO'YXATDAN CHIQARILMADI]") : ""}`,
				startMs: this.elapsedMs(call),
			})
		);

		await this.quietly("addNote(outcome)", () =>
			addNote(call.tenantId, {
				callId: call.callId,
				authorType: "ai",
				content: optOut
					? `Abonent boshqa qo'ng'iroq qilinmasligini so'radi. Sabab: ${args.reason}` +
						(optOutStored
							? " Raqam «qo'ng'iroq qilinmasin» ro'yxatiga qo'shildi."
							: " DIQQAT: raqamni ro'yxatga qo'shib bo'lmadi, qo'lda qo'shish kerak!")
					: `Qo'ng'iroq natijasi: ${args.outcome}. ${args.reason}`,
			})
		);

		await reportOutboundOutcome({
			callId: call.callId,
			campaignId: outbound.campaignId,
			leadId: outbound.leadId,
			phone: call.callerNumber,
			outcome: args.outcome,
			reason: args.reason,
			callBackAt: args.callBackAt ?? null,
			optOut,
			source: "conversation",
			durationSeconds,
			at,
		});

		logger.info(
			{
				callId: call.callId,
				campaignId: outbound.campaignId,
				leadId: outbound.leadId,
				outcome: args.outcome,
				optOut,
				optOutStored,
			},
			"recorded an outbound call outcome"
		);

		if (optOut) {
			return {
				ok: true,
				message:
					"Recorded, and this number will not be called again. Say one short line confirming " +
					"that, thank them, and call end_call. Do not ask why and do not offer anything.",
			};
		}

		return {
			ok: true,
			message:
				"Recorded. Do not record another outcome on this call. Finish the call politely when " +
				"there is nothing left to do.",
		};
	}

	private toolEndCall(call: ActiveCall, args: EndCallArgs): unknown {
		call.endReason = args.reason;
		call.closingSpeech = true;

		// Usually the model has already said goodbye and the audio is still draining
		// at 20 ms per frame, so cutting the channel on a fixed timer clipped it.
		// When it called this silently, though, there is nothing to drain and the
		// caller would simply be cut off mid-conversation - so a closing line is
		// spoken first and then waited for.
		this.track(
			this.announceBeforeAction(
				call,
				closingAnnouncement(this.callLanguage(call)),
				END_CALL_MAX_WAIT_MS
			).then(() => this.hangupCall(call.tenantId, call.callId, `end_call:${args.reason}`)),
			`end_call ${call.callId}`
		);

		return { ok: true, message: "The call will be closed. Say nothing further." };
	}

	// -----------------------------------------
	// Transfers
	// -----------------------------------------

	/**
	 * Which extension a transfer should aim for.
	 *
	 * The business's `transferExtensions` are the humans the owner nominated, so
	 * they decide two things: an extension the model asked for is honoured only when
	 * the owner listed it (otherwise the agent could dial anything a caller reads
	 * out), and with nothing requested the owner's first choice is preferred.
	 *
	 * transfer.ts still owns the outcome: an unknown or unreachable preference falls
	 * through to the first free online operator there, and a preference that rings
	 * nobody ends up in failTransfer(), which hands the caller back to the agent.
	 */
	private resolveTransferPreference(call: ActiveCall, requested: string | null): string | null {
		const profile = call.profile;
		const configured = profile?.isConfigured
			? profile.transferExtensions.map((value) => value.trim()).filter((value) => value.length > 0)
			: [];

		if (requested !== null) {
			if (configured.length === 0 || configured.includes(requested)) {
				return requested;
			}

			logger.warn(
				{ callId: call.callId, requested, configured },
				"the requested extension is not one this business configured; using its own list instead"
			);
		}

		return configured[0] ?? null;
	}

	private async startTransfer(
		call: ActiveCall,
		input: { reason: string; preferredExtension?: string | null }
	): Promise<TransferOutcome> {
		if (call.transfer.phase === "requested" || call.transfer.phase === "connected") {
			return {
				connected: call.transfer.phase === "connected",
				extension: call.transfer.extension,
				transferId: call.transfer.transferId,
				failureReason: call.transfer.failureReason,
				callerRetained: true,
				alreadyInProgress: true,
			};
		}

		call.transfer = {
			phase: "requested",
			extension: null,
			transferId: null,
			toChannelId: null,
			reason: input.reason,
			failureReason: null,
		};
		call.status = "transferring";

		const aiSessionId = call.aiSessionId;

		if (aiSessionId !== null) {
			await this.quietly("updateAiSession(transferring)", () =>
				updateAiSession(call.tenantId, aiSessionId, { status: "transferring" })
			);
		}

		await this.quietly("appendTranscript(system)", () =>
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: "system",
				content: `Qo'ng'iroq operatorga uzatilmoqda. Sabab: ${input.reason}`,
				startMs: this.elapsedMs(call),
				endMs: this.elapsedMs(call),
			})
		);

		this.broadcastTransfer(call, "requested");

		// A prompt still playing would fight the hold music transfer.ts starts.
		await this.stopPlayback(call);

		const result = await transferToHuman({
			tenantId: call.tenantId,
			// Already resolved for this call, so the handover cannot land in a different
			// context from the one the caller's own dialplan lives in.
			tenantSlug: call.tenantSlug,
			callId: call.callId,
			channelId: call.channelId,
			aiSessionId: call.aiSessionId,
			reason: input.reason,
			preferredExtension: input.preferredExtension ?? null,
			callerNumber: call.callerNumber,
			ari: this.ari,
		});

		call.transfer.extension = result.extension.length > 0 ? result.extension : null;
		call.transfer.transferId = result.transferId;
		call.transfer.toChannelId = result.toChannelId;

		if (result.connected) {
			await this.completeTransfer(call);

			return {
				connected: true,
				extension: call.transfer.extension,
				transferId: result.transferId,
				failureReason: null,
				callerRetained: true,
				alreadyInProgress: false,
			};
		}

		await this.failTransfer(call, result.failureReason, result.callerRetained);

		return {
			connected: false,
			extension: call.transfer.extension,
			transferId: result.transferId,
			failureReason: result.failureReason,
			callerRetained: result.callerRetained,
			alreadyInProgress: false,
		};
	}

	private async completeTransfer(call: ActiveCall): Promise<void> {
		call.transfer.phase = "connected";
		call.status = "transferred";

		// The AI is done, but the CALL is not: the human leg keeps talking, and the
		// call row is finalised when the channel is destroyed.
		this.clearCallTimers(call);

		if (call.transfer.extension !== null) {
			const operator = await resolveOperatorByExtension(
				call.tenantId,
				call.transfer.extension
			).catch((cause: unknown) => {
				logger.warn({ err: cause }, "could not resolve the operator behind the extension");
				return null;
			});
			call.operatorUserId = operator?.userId ?? null;
		}

		await this.quietly("appendTranscript(system)", () =>
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: "system",
				content: `Qo'ng'iroq ${call.transfer.extension ?? "operator"} raqamiga ulandi.`,
				startMs: this.elapsedMs(call),
				endMs: this.elapsedMs(call),
			})
		);

		this.broadcastTransfer(call, "connected");
		await this.endAiPath(call, { reason: "transferred" });

		logger.info(
			{ callId: call.callId, extension: call.transfer.extension },
			"call transferred to a human operator"
		);
	}

	private async failTransfer(
		call: ActiveCall,
		failureReason: string | null,
		callerRetained: boolean
	): Promise<void> {
		call.transfer.phase = "failed";
		call.transfer.failureReason = failureReason;
		call.status = callerRetained ? "live" : "ending";

		await this.quietly("appendTranscript(system)", () =>
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: "system",
				content: `Operatorga ulanmadi (${failureReason ?? "sabab aniqlanmadi"}).`,
				startMs: this.elapsedMs(call),
				endMs: this.elapsedMs(call),
			})
		);

		this.broadcastTransfer(call, "failed");

		switch (classifyFailedTransfer(callerRetained, call.providerName)) {
			case "caller-gone":
				// [ai-transfer] hangs the caller up itself after a failed Dial; there is
				// nobody left to talk to, so only the AI side is closed here.
				await this.endAiPath(call, { reason: `transfer-failed:${failureReason ?? "unknown"}` });
				return;

			case "no-agent-left":
				// No model to apologise on our behalf: play a prompt so the caller is not
				// left holding a silent line, then release the channel.
				await this.playPrompt(call, TROUBLE_MEDIA, 8_000);
				await this.hangupCall(
					call.tenantId,
					call.callId,
					`transfer-failed:${failureReason ?? "unknown"}`
				);
				return;

			default:
				break;
		}

		// The announced transfer did not happen, so the protection the announcement
		// bought must not outlive it. `announceBeforeAction` latched this to keep a
		// cough from cutting "Sizni operatorga ulayapman" off mid-word; the caller is
		// now back with the agent, and left latched it turns onInterruption into a
		// no-op for the rest of the call - every barge-in from here would leave the
		// agent talking over them. Both providers clear their own suppressBargeIn flag
		// when the protected turn ends, for exactly this reason; this is the
		// orchestrator's half of the same rule.
		call.closingSpeech = false;

		// The AI still owns the caller: re-arm the guards it was running under, and
		// the tool result tells it to apologise and offer to register the request.
		this.armTimers(call);
	}

	// -----------------------------------------
	// Timers
	// -----------------------------------------

	/**
	 * How long this call may run, and how much silence ends it.
	 *
	 * The business's own limits win once it has a profile - a taxi dispatcher wants
	 * short calls, a clinic taking a booking does not - and the environment stays
	 * the fallback for a deployment nobody has configured yet.
	 */
	private maxCallMs(call: ActiveCall): number {
		const profile = call.profile;

		if (profile?.isConfigured && profile.maxCallSeconds > 0) {
			return profile.maxCallSeconds * 1000;
		}

		return getAiRuntimeConfig(call.tenantId).maxCallSeconds * 1000;
	}

	private silenceHangupMs(call: ActiveCall): number {
		const profile = call.profile;

		if (profile?.isConfigured && profile.silenceHangupMs > 0) {
			return profile.silenceHangupMs;
		}

		return getAiRuntimeConfig(call.tenantId).silenceHangupMs;
	}

	private armTimers(call: ActiveCall): void {
		call.maxDurationTimer = clearTimer(call.maxDurationTimer);

		const elapsedMs = Date.now() - call.startedAtMs;
		const remainingMs = Math.max(1_000, this.maxCallMs(call) - elapsedMs);

		call.maxDurationTimer = setTimeout(() => {
			call.maxDurationTimer = null;
			this.track(this.endForLimit(call, "max-duration"), `max duration ${call.callId}`);
		}, remainingMs);

		this.touchActivity(call);
	}

	/** Any sign of life on the line: caller speech, agent speech, a tool, a digit. */
	private touchActivity(call: ActiveCall): void {
		call.lastActivityAt = Date.now();

		call.silenceTimer = clearTimer(call.silenceTimer);

		if (call.aiPathClosed || call.transfer.phase === "connected") {
			return;
		}

		// Nothing to classify when this fires: everything that could mean somebody is
		// there has already reset it, so a whole window with none of them is an empty
		// line. Whether the AGENT is answering is a separate question with its own
		// timer - see the note by classifyAgentStall.
		call.silenceTimer = setTimeout(() => {
			call.silenceTimer = null;
			this.track(this.endForLimit(call, "silence"), `silence ${call.callId}`);
		}, this.silenceHangupMs(call));
	}

	/**
	 * The caller is audible. Satisfy the silence guard, and start the other one.
	 *
	 * Throttled, because a talking caller produces this fifty times a second and the
	 * timers it moves are measured in tens of seconds.
	 */
	private noteCallerSpeech(call: ActiveCall): void {
		const now = Date.now();

		if (now - call.lastCallerSpeechNotifyAt < CALLER_SPEECH_NOTIFY_INTERVAL_MS) {
			return;
		}

		call.lastCallerSpeechNotifyAt = now;

		this.touchActivity(call);
		this.armAgentStallTimer(call);
	}

	/**
	 * Start counting the agent's silence, from the caller's first word after the
	 * agent last spoke.
	 *
	 * Deliberately NOT restarted while it runs: the window has to measure how long
	 * the agent has been quiet, and re-arming it on every word the caller says would
	 * make a talking caller push it back forever - which is precisely how the
	 * previous attempt at this ended up unreachable.
	 */
	private armAgentStallTimer(call: ActiveCall, delayMs?: number): void {
		if (call.agentStallTimer !== null || call.aiPathClosed || call.finalized) {
			return;
		}

		if (call.transfer.phase === "requested" || call.transfer.phase === "connected") {
			// The caller is listening to hold music or to a person; the agent is
			// supposed to be silent.
			return;
		}

		call.agentStallTimer = setTimeout(() => {
			call.agentStallTimer = null;
			this.track(this.handleAgentStall(call), `agent stall ${call.callId}`);
		}, delayMs ?? this.silenceHangupMs(call));
	}

	/**
	 * Send the agent's audio to the caller, and note that the agent is alive.
	 *
	 * Every route to the caller's ear goes through here - the model's own speech and
	 * the platform's pre-rendered lines alike - which is what makes clearing the
	 * stall timer here equivalent to "the agent has produced audio".
	 */
	private sendAgentAudio(call: ActiveCall, slin8k: Buffer): void {
		call.session?.send(slin8k);
		call.agentStallTimer = clearTimer(call.agentStallTimer);
	}

	/**
	 * The agent has produced nothing for a whole window. Decide whether that is its
	 * fault, and if so, do not hang up on the caller.
	 *
	 * Hanging up is the one response that is certainly wrong here: the caller did
	 * nothing, has already invested a minute of explaining, and would be cut off
	 * mid-sentence by the very system they are talking to. So the platform speaks
	 * for itself instead - a short line that both keeps the caller informed and
	 * gives a stalled session a fresh turn to restart on - and logs the fault at
	 * error level with the measurements behind it.
	 *
	 * From here the max-duration timer is the only hard stop, which is deliberate.
	 * It is bounded (the profile's own maxCallSeconds), it is the same limit a
	 * healthy call runs under, and it cannot fire on somebody mid-sentence without
	 * that being true of every call on the platform. A transfer is NOT used as the
	 * escape hatch: it depends on an operator leg actually connecting, which is a
	 * separate moving part, and a recovery path that can fail on its own is not a
	 * recovery path. The caller can still reach a person by pressing 0, which runs
	 * through DTMF and needs nothing from the model.
	 */
	private async handleAgentStall(call: ActiveCall): Promise<void> {
		if (call.aiPathClosed || call.finalized) {
			return;
		}

		if (call.transfer.phase === "requested" || call.transfer.phase === "connected") {
			// Hold music or a human has the caller; the agent is meant to be quiet.
			return;
		}

		const msSinceCallerVoice = call.callerVoice.msSinceVoice();
		const verdict = classifyAgentStall(msSinceCallerVoice, AGENT_STALL_TURN_GAP_MS);

		if (verdict === "no-caller") {
			// Nobody has been heard on this line at all, so there is no turn going
			// unanswered. The silence guard is the one with a job here.
			return;
		}

		if (verdict === "caller-mid-turn") {
			// A model listening to a caller who has not finished looks exactly like a
			// model that has gone deaf, and interrupting the first to catch the second
			// would be worse than the fault. Look again one turn-gap later, which is
			// the soonest the answer can differ.
			this.armAgentStallTimer(call, AGENT_STALL_TURN_GAP_MS);
			return;
		}

		call.agentStalls += 1;

		const windowMs = this.silenceHangupMs(call);

		// Energy said somebody is there; the model never turned any of it into a
		// word, and the agent has answered nothing. Two independent signals disagree
		// and the cheaper one is the one that is wrong on a fluctuating line, so stop
		// believing it and let the line be closed like any other empty one.
		if (
			isUncorroboratedStall(call.agentStalls, call.callerTranscripts, MAX_UNCORROBORATED_STALLS)
		) {
			logger.warn(
				{
					callId: call.callId,
					stalls: call.agentStalls,
					callerAudio: call.callerVoice.stats(),
				},
				"caller audio was never transcribed across repeated stalls; treating the line as empty"
			);
			await this.endForLimit(call, "silence");
			return;
		}

		logger.error(
			{
				callId: call.callId,
				provider: call.providerName,
				stalls: call.agentStalls,
				stallWindowMs: windowMs,
				msSinceCallerVoice,
				responseTurns: call.responseTurns,
				callerAudio: call.callerVoice.stats(),
			},
			"the caller spoke and the agent answered nothing for a whole window; keeping the call up"
		);

		if (call.agentStalls <= MAX_AGENT_STALL_NOTES) {
			await this.quietly("appendTranscript(system)", () =>
				appendTranscript(call.tenantId, {
					callId: call.callId,
					aiSessionId: call.aiSessionId,
					role: "system",
					content:
						`Fuqaro gapirib turibdi, lekin agent ${windowMs} ms davomida javob bermadi ` +
						`(${call.agentStalls}-marta). Qo'ng'iroq yakunlanmadi.`,
					startMs: this.elapsedMs(call),
					endMs: this.elapsedMs(call),
				})
			);
		}

		if (call.agentStalls <= MAX_AGENT_STALL_RECOVERIES) {
			await this.speakStallRecovery(call);
		}

		// Speaking took seconds, and the caller may have hung up during them.
		if (call.aiPathClosed || call.finalized) {
			return;
		}

		// The platform just spoke, which is activity like any other: the silence guard
		// measures from here, so its next deadline is about silence that FOLLOWS the
		// recovery line rather than silence that preceded it. The stall guard is not
		// re-armed - it starts again on the caller's next word, which is the next time
		// there is an unanswered turn to measure.
		this.touchActivity(call);
	}

	/** The platform's own "say that again" line, spoken without ending anything. */
	private async speakStallRecovery(call: ActiveCall): Promise<void> {
		// A goodbye already in flight owns the rest of the call; talking over it
		// would replace a farewell the caller is listening to with a request to
		// repeat themselves.
		if (call.closingSpeech || call.session === null) {
			return;
		}

		const line = agentStallLine(this.callLanguage(call));
		const spoken = await this.speakFixedLine(call, line);

		// The model is the fallback, not the first choice: the whole reason this
		// line exists is that the model has stopped producing audio, so the
		// pre-rendered voice is the one likely to actually reach the caller.
		if (!spoken && call.provider !== null && call.providerName !== FALLBACK_IVR_PROVIDER_NAME) {
			call.provider.say(line);
		}

		await this.waitForAgentAudioToFinish(call, STALL_RECOVERY_MAX_WAIT_MS);
	}

	private clearCallTimers(call: ActiveCall): void {
		call.greetingTimer = clearTimer(call.greetingTimer);
		call.maxDurationTimer = clearTimer(call.maxDurationTimer);
		call.silenceTimer = clearTimer(call.silenceTimer);
		call.agentStallTimer = clearTimer(call.agentStallTimer);
	}

	private armFinalizeSafety(call: ActiveCall, reason: string): void {
		call.finalizeTimer = clearTimer(call.finalizeTimer);

		call.finalizeTimer = setTimeout(() => {
			call.finalizeTimer = null;

			if (!this.calls.has(call.callId)) {
				return;
			}

			logger.warn(
				{ callId: call.callId },
				"no ChannelDestroyed arrived after the hangup; finalising the call anyway"
			);
			this.track(
				this.finalizeCall(call, { reason: `${reason}:safety-net` }),
				`safety finalise ${call.callId}`
			);
		}, FINALIZE_SAFETY_MS);
	}

	/** Max-duration and silence both end the call, politely, with a spoken line. */
	private async endForLimit(call: ActiveCall, kind: "silence" | "max-duration"): Promise<void> {
		if (call.aiPathClosed || call.finalized || call.transfer.phase === "connected") {
			return;
		}

		logger.warn({ callId: call.callId, kind }, "ending the call on a guard timer");

		await this.quietly("appendTranscript(system)", () =>
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: "system",
				content:
					kind === "silence"
						? `Jimlik ${this.silenceHangupMs(call)} ms davom etdi, qo'ng'iroq yakunlandi.`
						: `Qo'ng'iroq ${Math.round(this.maxCallMs(call) / 1000)} s cheklovga yetdi va yakunlandi.`,
				startMs: this.elapsedMs(call),
				endMs: this.elapsedMs(call),
			})
		);

		const provider = call.provider;

		if (
			provider !== null &&
			call.providerName !== FALLBACK_IVR_PROVIDER_NAME &&
			call.session !== null
		) {
			call.closingSpeech = true;
			provider.say(goodbyeLine(this.callLanguage(call), kind));
			await this.waitForAgentAudioToFinish(call, SPOKEN_GOODBYE_MAX_WAIT_MS);
		} else {
			await this.playPrompt(call, GOODBYE_MEDIA, 8_000);
		}

		await this.hangupCall(call.tenantId, call.callId, kind);
	}

	/**
	 * Make sure the caller has been TOLD before something happens to their call.
	 *
	 * A transfer or a hangup is the one moment where acting first and explaining
	 * afterwards is useless: by the time the words would arrive the caller is
	 * already listening to ringing, or to nothing. The model is instructed to
	 * announce these itself, and usually does - but an instruction is a request,
	 * not a guarantee, and a silent tool call left the caller with no idea what
	 * had happened.
	 *
	 * So: if the model is already speaking, let it finish and say nothing extra.
	 * Only when it went silent does the platform speak its own line. Either way
	 * the audio is drained before the caller's call is touched.
	 */
	private async announceBeforeAction(
		call: ActiveCall,
		line: string,
		budgetMs: number
	): Promise<void> {
		const session = call.session;
		const provider = call.provider;

		if (session === null || provider === null) {
			return;
		}

		// From here the agent's turn must survive to the end: the wait below drains
		// it, and a cough that cancelled it would leave the goodbye stopped mid-word.
		call.closingSpeech = true;
		provider.suppressBargeIn?.();

		// Queued frames mean the model followed its instructions and is mid-sentence.
		// A second, platform-written line on top of that is one the caller did not
		// need and would talk over the first.
		if (session.queuedFrames() === 0) {
			const spoken = await this.speakFixedLine(call, line);

			if (!spoken) {
				provider.say(line);
			}
		}

		await this.waitForAgentAudioToFinish(call, budgetMs);
	}

	/**
	 * Speak a line whose text is fixed, in the ElevenLabs voice, from disk.
	 *
	 * The greeting, the goodbye and the transfer announcement are the same string
	 * on every call, which is what makes them the right - and the only sensible -
	 * place for a voice that needs 1.7 seconds to start speaking. Rendered once,
	 * cached, and after that served at zero latency for no further cost.
	 *
	 * Everything downstream is unchanged: the audio goes into the same AudioSocket
	 * queue as the model's own speech, so pacing, barge-in and the drain wait all
	 * behave exactly as they already do.
	 *
	 * @returns true when the line was spoken here; false means the caller should
	 *          fall back to `provider.say()` and the realtime voice.
	 */
	private async speakFixedLine(call: ActiveCall, text: string): Promise<boolean> {
		const session = call.session;

		if (session === null || !isElevenLabsConfigured()) {
			return false;
		}

		let speech: RenderedSpeech | null = null;

		try {
			speech = await renderCached(text);
		} catch (cause) {
			// A voice vendor being down must never cost a call: the realtime model
			// can say the same words.
			logger.warn({ err: cause, callId: call.callId }, "ElevenLabs line failed; using the model");
			return false;
		}

		if (speech === null) {
			return false;
		}

		// u-law in, slin out: the AudioSocket queue speaks 8 kHz PCM16.
		this.sendAgentAudio(call, muLawDecode(speech.ulaw));
		session.flush();

		logger.info(
			{ callId: call.callId, ms: speech.durationMs, cached: speech.cached },
			"spoke a fixed line in the ElevenLabs voice"
		);

		await this.quietly("appendTranscript(agent)", () =>
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: "agent",
				content: text,
				startMs: this.elapsedMs(call),
				endMs: this.elapsedMs(call) + speech.durationMs,
			})
		);

		return true;
	}

	/**
	 * Wait until the agent's closing line has actually reached the caller.
	 *
	 * `say()` returns as soon as the model has been asked to speak. The audio then
	 * arrives over roughly the next second and takes as long to play out as it does
	 * to listen to, because the pacer emits one 20 ms frame every 20 ms. Hanging up
	 * on a fixed timer therefore truncated the farewell; on a measured call 112
	 * frames (2.2 s) were still queued when the channel was cut.
	 *
	 * `budgetMs` is a ceiling, not a delay: this returns as soon as the queue is
	 * empty.
	 */
	private async waitForAgentAudioToFinish(call: ActiveCall, budgetMs: number): Promise<void> {
		const session = call.session;

		if (session === null) {
			return;
		}

		const deadline = Date.now() + budgetMs;

		// The queue is still empty right after say(), so waiting on it immediately
		// would return at once. Give the first audio a bounded chance to show up.
		const startDeadline = Math.min(deadline, Date.now() + AGENT_AUDIO_START_WAIT_MS);

		while (session.queuedFrames() === 0 && !session.isClosed && Date.now() < startDeadline) {
			await sleep(AGENT_AUDIO_POLL_MS);
		}

		if (session.isClosed) {
			return;
		}

		const drained = await session.waitForQueueDrain(Math.max(0, deadline - Date.now()));

		if (!drained) {
			logger.debug(
				{ callId: call.callId, framesLeft: session.queuedFrames() },
				"closing line did not finish draining within its budget"
			);
		}

		await sleep(AGENT_AUDIO_PLAYOUT_MARGIN_MS);
	}

	// -----------------------------------------
	// Playback
	// -----------------------------------------

	private async playPrompt(
		call: ActiveCall,
		media: string,
		maxWaitMs = PLAYBACK_MAX_WAIT_MS
	): Promise<void> {
		if (call.handedToDialplan) {
			// ARI cannot play into a channel executing AudioSocket() - it answers 409.
			logger.debug(
				{ callId: call.callId, media },
				"skipping the prompt: the channel is not in Stasis"
			);
			return;
		}

		let playbackId: string;

		try {
			playbackId = await this.ari.playback(call.channelId, media);
		} catch (cause) {
			logger.warn({ err: cause, callId: call.callId, media }, "could not play the prompt");
			return;
		}

		call.playbackId = playbackId;

		await this.quietly("appendTranscript(system)", () =>
			appendTranscript(call.tenantId, {
				callId: call.callId,
				aiSessionId: call.aiSessionId,
				role: "system",
				content: `Asterisk "${media}" ovoz yozuvi eshittirildi.`,
				startMs: this.elapsedMs(call),
				endMs: this.elapsedMs(call),
			})
		);

		await this.waitForPlayback(playbackId, maxWaitMs);

		if (call.playbackId === playbackId) {
			call.playbackId = null;
		}
	}

	private waitForPlayback(playbackId: string, maxWaitMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.playbackWaiters.delete(playbackId);
				resolve();
			}, maxWaitMs);

			this.playbackWaiters.set(playbackId, () => {
				clearTimeout(timer);
				this.playbackWaiters.delete(playbackId);
				resolve();
			});
		});
	}

	private settlePlayback(playbackId: string): void {
		const waiter = this.playbackWaiters.get(playbackId);

		if (waiter !== undefined) {
			waiter();
		}
	}

	private async stopPlayback(call: ActiveCall): Promise<void> {
		const playbackId = call.playbackId;

		if (playbackId === null) {
			return;
		}

		call.playbackId = null;
		await this.quietly("ari.stopPlayback", () => this.ari.stopPlayback(playbackId));
		this.settlePlayback(playbackId);
	}

	// -----------------------------------------
	// Teardown
	// -----------------------------------------

	/**
	 * Close the AI half of the call: timers, provider, counters, ai_sessions row.
	 * Idempotent - the flag is set before anything else runs, so the provider's own
	 * onClose (which stop() triggers) cannot re-enter.
	 */
	private async endAiPath(
		call: ActiveCall,
		options: { reason: string; errorMessage?: string | null }
	): Promise<void> {
		if (call.aiPathClosed) {
			return;
		}

		call.aiPathClosed = true;
		this.clearCallTimers(call);
		call.interim.clear();

		const provider = call.provider;

		if (provider !== null) {
			await this.quietly("provider.stop", () => provider.stop(options.reason));
		}

		const aiSessionId = call.aiSessionId;

		if (aiSessionId === null) {
			return;
		}

		// Transcription is billed even when the model never answered, so a session
		// that only heard the caller still has a cost to record.
		const reportedUsage =
			call.promptTokens > 0 ||
			call.completionTokens > 0 ||
			call.transcribeAudioTokens > 0 ||
			call.transcribeTextTokens > 0;

		if (reportedUsage) {
			await this.quietly("updateAiSession(tokens)", () =>
				updateAiSession(call.tenantId, aiSessionId, {
					promptTokens: call.promptTokens,
					completionTokens: call.completionTokens,
					cachedPromptTokens: call.cachedTokens,
					cachedAudioTokens: call.cachedAudioTokens,
					cachedTextTokens: call.cachedTextTokens,
					inputTextTokens: call.inputTextTokens,
					inputAudioTokens: call.inputAudioTokens,
					outputTextTokens: call.outputTextTokens,
					outputAudioTokens: call.outputAudioTokens,
					responseTurns: call.responseTurns,
					transcribeAudioTokens: call.transcribeAudioTokens,
					transcribeTextTokens: call.transcribeTextTokens,
					transcribeModel: call.transcribeModel,
				})
			);
		}

		const errorMessage = options.errorMessage ?? call.aiError;

		await this.quietly("finishAiSession", () =>
			finishAiSession(call.tenantId, aiSessionId, {
				// "failed" only when the provider itself broke. A call the IVR fallback
				// handled end to end did its job, so it is not a failed session.
				status: call.aiError === null ? "completed" : "failed",
				errorMessage,
				stats: provider?.stats() ?? null,
			})
		);
	}

	/**
	 * Finalise the CRM call: end the row, store the recording, broadcast, and hand
	 * the transcript to the post-call analysis. Runs at most once per call.
	 */
	private async finalizeCall(
		call: ActiveCall,
		options: { reason: string; status?: CallStatus }
	): Promise<void> {
		if (call.finalized) {
			return;
		}

		call.finalized = true;
		call.finalizeTimer = clearTimer(call.finalizeTimer);
		call.endReason = call.endReason ?? options.reason;

		await this.endAiPath(call, { reason: options.reason });
		await this.stopPlayback(call);

		const durationSeconds = Math.max(0, Math.round((Date.now() - call.startedAtMs) / 1000));
		const status = options.status ?? this.resolveEndStatus(call);

		await this.quietly("markCallEnded", () =>
			markCallEnded(call.tenantId, call.callId, { status, durationSeconds })
		);

		if (call.usesAudioSocket || call.fallbackRecordingPath !== null) {
			// Two producers, one path: MixMonitor for calls that reached
			// [ai-bridge], ARI recording for fallback calls that stayed in Stasis.
			// Both write ${ASTERISK_RECORDINGS_DIR}/${callId}.wav - the container
			// symlinks Asterisk's own recording dir onto that bind mount. A row is
			// still written when the file is missing, flagged isAvailable=false,
			// rather than silently dropping the fact that a call happened.
			await this.quietly("saveRecording", () =>
				saveRecording(call.tenantId, {
					callId: call.callId,
					filePath: recordingPathFor(call.callId, call.tenantSlug),
					durationSeconds,
				})
			);
		}

		await this.reportOutboundTeardown(call, durationSeconds);

		call.status = "ended";
		this.calls.delete(call.callId);
		this.callsByChannel.delete(call.channelId);

		this.broadcast(
			{
				type: LIVE_CALL_EVENTS.ended,
				callId: call.callId,
				status,
				durationSeconds,
				ticketId: call.ticketId,
				transferExtension: call.transfer.extension,
				endReason: call.endReason,
			},
			call
		);

		logger.info(
			{
				callId: call.callId,
				status,
				durationSeconds,
				reason: options.reason,
				provider: call.providerName,
				ticketId: call.ticketId,
				// What this call cost.
				//
				// The OUTPUT side is disjoint: outAudio + outText = the completion
				// total, so those two can be added up and priced directly.
				//
				// The INPUT side is NOT. It has two independent axes - cache (fresh vs
				// cached) and modality (text vs audio). inPromptFresh + inPromptCached is
				// the prompt total; inAudio + inText is the SAME total seen the other way.
				// Adding all four double counts. cachedAudio/cachedText are the 2x2 cells
				// where the axes cross, which OpenAI reports and Gemini does not; when
				// they are absent lib/ai-cost/price.ts apportions instead and labels the
				// result an estimate.
				//
				// cachedShare is reported alongside, not as a health signal: turn one
				// of any call is always uncached, so a short call reads low for a reason
				// that has nothing to do with the prompt being unstable.
				tokens: {
					inPromptFresh: Math.max(0, call.promptTokens - call.cachedTokens),
					inPromptCached: call.cachedTokens,
					cachedAudio: call.cachedAudioTokens,
					cachedText: call.cachedTextTokens,
					inAudio: call.inputAudioTokens,
					inText: call.inputTextTokens,
					outAudio: call.outputAudioTokens,
					outText: call.outputTextTokens,
					transcribeAudio: call.transcribeAudioTokens,
					cachedShare:
						call.promptTokens > 0
							? Math.round((call.cachedTokens / call.promptTokens) * 100) / 100
							: 0,
					// Billed turns only: a barge-in cancels a response that still reports
					// usage with zero output, and those are not counted here.
					turns: call.responseTurns,
				},
			},
			"call finalised"
		);

		this.track(
			this.runPostCallAnalysis({
				callId: call.callId,
				tenantId: call.tenantId,
				language: this.callLanguage(call),
				businessName: call.profile?.businessName ?? null,
				categories: call.profile?.ticketCategories ?? null,
				providerName: call.providerName,
				aiError: call.aiError,
				unavailableReason: call.unavailableReason,
			}),
			`post-call analysis ${call.callId}`
		);
	}

	/**
	 * Make sure a campaign call reports SOMETHING when it ends.
	 *
	 * A no-op on inbound calls, and a no-op on the campaign calls that went well -
	 * record_call_outcome already reported those the moment the person spoke, and
	 * overwriting a real answer here with a blander one is exactly what this must not
	 * do.
	 *
	 * It exists for the call that had a conversation and no conclusion: the person
	 * hung up mid-sentence, the model never called the tool, the provider died. The
	 * dialer has to be told, or the lead sits at "in progress" for ever and is never
	 * retried and never closed. "answered" is the honest report - we know the phone
	 * was picked up and we know nothing else.
	 */
	private async reportOutboundTeardown(call: ActiveCall, durationSeconds: number): Promise<void> {
		const outbound = call.outbound;

		if (outbound === null || outbound.reportedOutcome !== null) {
			return;
		}

		outbound.reportedOutcome = "answered";

		await reportOutboundOutcome({
			callId: call.callId,
			campaignId: outbound.campaignId,
			leadId: outbound.leadId,
			phone: call.callerNumber,
			outcome: "answered",
			reason: "Suhbat bo'ldi, lekin natija qayd etilmadi",
			callBackAt: null,
			optOut: false,
			source: "conversation",
			durationSeconds,
			at: new Date().toISOString(),
		});

		logger.warn(
			{
				callId: call.callId,
				campaignId: outbound.campaignId,
				leadId: outbound.leadId,
				endReason: call.endReason,
			},
			"an outbound call ended with no recorded outcome; reported as answered"
		);
	}

	private resolveEndStatus(call: ActiveCall): CallStatus {
		if (call.transfer.phase === "connected") {
			return "completed";
		}

		if (!call.answered) {
			// The caller went away while we were still setting the call up.
			return "abandoned";
		}

		return "completed";
	}

	// -----------------------------------------
	// Post-call analysis
	// -----------------------------------------

	/**
	 * Summarise the finished call into the EXISTING ai_analyses table (and the
	 * mirrored ticket columns the dashboard already reads).
	 *
	 * A call with nothing said is recorded as a FAILED analysis with the reason,
	 * never as a successful empty summary: "the AI was unavailable" and "the AI
	 * found nothing to report" must not look the same in the queue.
	 */
	private async runPostCallAnalysis(target: PostCallTarget): Promise<void> {
		let transcript: TranscriptTextResult;

		try {
			transcript = await buildTranscriptText(target.tenantId, target.callId);
		} catch (cause) {
			logger.error(
				{ err: cause, callId: target.callId },
				"could not read the transcript for the post-call analysis"
			);
			return;
		}

		if (transcript.text.length === 0 || transcript.callerTurnCount === 0) {
			const reason =
				target.aiError ??
				target.unavailableReason ??
				"no caller speech was transcribed for this call";

			await this.quietly("writeAiAnalysis(failed)", () =>
				writeAiAnalysis(target.tenantId, {
					callId: target.callId,
					transcript: transcript.text.length > 0 ? transcript.text : null,
					status: "failed",
					errorMessage: `Post-call analysis not possible: ${reason}`,
				})
			);

			this.broadcast(
				{
					type: LIVE_CALL_EVENTS.analysis,
					callId: target.callId,
					aiStatus: "failed",
					summary: null,
				},
				null,
				target.tenantId
			);
			return;
		}

		try {
			const summary = await this.summarise({
				callId: target.callId,
				tenantId: target.tenantId,
				transcript: transcript.text,
				language: target.language,
				businessName: target.businessName ?? undefined,
				categories: target.categories ?? undefined,
			});

			await writeAiAnalysis(target.tenantId, {
				callId: target.callId,
				transcript: transcript.text,
				summary: summary.summary,
				sentiment: summary.sentiment,
				categories: summary.categories,
				confidence: summary.confidence,
				status: "completed",
				usage: summary.usage,
			});

			this.broadcast(
				{
					type: LIVE_CALL_EVENTS.analysis,
					callId: target.callId,
					aiStatus: "completed",
					summary: summary.summary,
				},
				null,
				target.tenantId
			);

			logger.info(
				{ callId: target.callId, turns: transcript.turnCount },
				"post-call analysis stored"
			);
		} catch (cause) {
			const message = describeError(cause);
			logger.warn(
				{ callId: target.callId, detail: message },
				"the post-call summary could not be produced; storing the transcript as failed"
			);

			// The transcript is still stored, so the existing AI queue can retry the
			// summary later - retry_count is bumped by writeAiAnalysis.
			await this.quietly("writeAiAnalysis(failed)", () =>
				writeAiAnalysis(target.tenantId, {
					callId: target.callId,
					transcript: transcript.text,
					status: "failed",
					errorMessage: `Summarisation failed: ${message}`,
				})
			);

			this.broadcast(
				{
					type: LIVE_CALL_EVENTS.analysis,
					callId: target.callId,
					aiStatus: "failed",
					summary: null,
				},
				null,
				target.tenantId
			);
		}
	}

	// -----------------------------------------
	// Snapshots and broadcasting
	// -----------------------------------------

	private snapshot(call: ActiveCall): LiveCallSnapshot {
		return {
			callId: call.callId,
			tenantId: call.tenantId,
			channelId: call.channelId,
			callerNumber: call.callerNumber,
			direction: call.direction,
			status: call.status,
			provider: call.providerName,
			aiSessionId: call.aiSessionId,
			contact: call.contact,
			isReturningCaller: call.isReturningCaller,
			previousCallCount: call.previousCallCount,
			ticketId: call.ticketId,
			transferExtension: call.transfer.extension,
			transferStatus: call.transfer.phase,
			startedAt: call.startedAt.toISOString(),
			durationSeconds: Math.max(0, Math.round((Date.now() - call.startedAtMs) / 1000)),
		};
	}

	/**
	 * Fan a live-call event out to the RIGHT customer's dashboards.
	 *
	 * The tenant comes from the call while there is one, and is passed explicitly by
	 * the post-call paths where the call has already been torn down. An event with
	 * neither is dropped: these are dashboard updates, and delivering one to
	 * everybody because we could not say whose it was is not an acceptable fallback.
	 */
	private broadcast(event: LiveCallEvent, call: ActiveCall | null, tenantId?: TenantId): void {
		const scope = call?.tenantId ?? tenantId;

		if (scope === undefined) {
			logger.warn(
				{ type: event.type },
				"a live-call event had no tenant to deliver it to and was dropped"
			);
			return;
		}

		try {
			broadcastCallEvent(scope, event, call?.operatorUserId ?? null);
		} catch (cause) {
			logger.error({ err: cause, type: event.type }, "broadcasting a live-call event failed");
		}
	}

	private broadcastTranscript(
		call: ActiveCall,
		transcript: {
			role: TranscriptRole;
			content: string;
			isFinal: boolean;
			startMs: number | null;
			endMs: number | null;
		}
	): void {
		this.broadcast(
			{
				type: LIVE_CALL_EVENTS.transcript,
				callId: call.callId,
				role: transcript.role,
				content: transcript.content,
				isFinal: transcript.isFinal,
				startMs: transcript.startMs,
				endMs: transcript.endMs,
				at: new Date().toISOString(),
			},
			call
		);
	}

	private broadcastTransfer(call: ActiveCall, phase: TransferPhase): void {
		this.broadcast(
			{
				type: LIVE_CALL_EVENTS.transfer,
				callId: call.callId,
				phase,
				extension: call.transfer.extension,
				reason: call.transfer.reason,
				failureReason: call.transfer.failureReason,
				call: this.snapshot(call),
			},
			call
		);
	}

	// -----------------------------------------
	// Utilities
	// -----------------------------------------

	private elapsedMs(call: ActiveCall): number {
		return Math.max(0, Date.now() - call.startedAtMs);
	}

	/**
	 * The language the platform's own spoken lines use on this call: what the
	 * session was opened with, then the business's language, then the environment.
	 */
	private callLanguage(call: ActiveCall): string {
		return (
			readText(call.context?.language ?? null) ??
			readText(call.profile?.language ?? null) ??
			getAiRuntimeConfig(call.tenantId).language
		);
	}

	/** Best-effort step: log the failure, never let it break a teardown chain. */
	private async quietly(label: string, work: () => Promise<unknown>): Promise<void> {
		try {
			await work();
		} catch (cause) {
			logger.error({ err: cause }, `orchestrator step "${label}" failed`);
		}
	}

	/**
	 * Run a promise in the background without leaking an unhandled rejection, and
	 * keep a handle so stop() can wait for in-flight work (transcript writes, the
	 * post-call summary) instead of cutting it off mid-write.
	 */
	private track(work: Promise<unknown>, label: string): void {
		const tracked = work
			.then(() => undefined)
			.catch((cause: unknown) => {
				logger.error({ err: cause }, `orchestrator task "${label}" failed`);
			})
			.finally(() => {
				this.background.delete(tracked);
			});

		this.background.add(tracked);
	}
}

// ===========================================
// Singleton
// ===========================================

let sharedOrchestrator: CallOrchestrator | null = null;

/**
 * Process-wide orchestrator. One instance owns the AudioSocket listener and the
 * ARI subscription, so a second one would double-handle every call.
 */
export function getCallOrchestrator(options?: CallOrchestratorOptions): CallOrchestrator {
	if (sharedOrchestrator === null) {
		sharedOrchestrator = new CallOrchestrator(options);
	}

	return sharedOrchestrator;
}

/** Drop the singleton (tests, and a deliberate reconfigure at runtime). */
export function resetCallOrchestrator(): void {
	sharedOrchestrator = null;
}

/**
 * Ring one person about one thing.
 *
 * The function the dialer imports. It exists as a free function, and not just as
 * a method, so the campaign side never has to reach for the orchestrator
 * singleton, hold a reference to it across a hot reload, or know that ARI is
 * involved at all - it passes a number and a purpose and gets back a call id or a
 * reason it did not happen.
 */
export async function placeOutboundCall(
	request: OutboundCallRequest
): Promise<PlaceOutboundCallResult> {
	return await getCallOrchestrator().placeOutboundCall(request);
}
