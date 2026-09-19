// biome-ignore-all lint/style/useNamingConvention: ARI payloads keep Asterisk's own snake_case field names verbatim, so an event can go from the wire straight into a handler with no rewriting step.
/**
 * Telephony contracts - the single source of truth for the AI voice layer.
 *
 * This module is deliberately runtime-free: no ARI client, no OpenAI client,
 * no database, no logger. Everything here is a type or a plain Error subclass.
 * That is what lets the Asterisk adapter, the call orchestrator and the voice
 * providers be written, tested and swapped independently - they only have to
 * agree on the shapes below.
 *
 * Nothing here touches the existing FreePBX webhook path; the legacy flow keeps
 * using its own schemas under routes/webhooks.
 */

// ===========================================
// Asterisk resources (ARI wire shapes)
// ===========================================

/** Caller / connected-line pair as ARI renders it. Both fields are always present, often as "". */
export interface AsteriskCallerId {
	number: string;
	name: string;
}

/** Context/extension/priority triple, plus the currently executing application. */
export interface AsteriskDialplanCep {
	context: string;
	exten: string;
	priority: number;
	app_name?: string;
	app_data?: string;
}

/**
 * An ARI channel. `state` is Asterisk's own spelling ("Down", "Ring",
 * "Ringing", "Up", "Busy", ...) and is kept as a string rather than a union
 * because Asterisk adds states between releases and a stale union would make
 * an otherwise harmless event unparseable.
 */
export interface AsteriskChannel {
	id: string;
	name: string;
	state: string;
	caller: AsteriskCallerId;
	connected: AsteriskCallerId;
	dialplan: AsteriskDialplanCep;
	/** e.g. "2026-08-04T09:12:33.401+0000" - Asterisk's format, not strict ISO-8601. */
	creationtime: string;
	language: string;
	accountcode?: string;
	channelvars?: Record<string, string>;
}

/** An ARI bridge. `channels` holds channel ids, not names. */
export interface AsteriskBridge {
	id: string;
	technology: string;
	bridge_type: string;
	channels: string[];
	bridge_class?: string;
	creator?: string;
	name?: string;
	creationtime?: string;
}

/** Playback handle returned by POST /channels/{id}/play and carried by Playback* events. */
export interface AsteriskPlayback {
	id: string;
	media_uri: string;
	target_uri: string;
	state: string;
	language?: string;
	next_media_uri?: string;
}

// ===========================================
// ARI events
// ===========================================

/** Fields ARI puts on every event envelope. */
interface AriEventEnvelope {
	application: string;
	/** e.g. "2026-08-04T09:12:33.401+0000". */
	timestamp: string;
	asterisk_id?: string;
}

/** A channel entered our Stasis application. `args` are the Stasis() arguments after the app name. */
export interface AriStasisStartEvent extends AriEventEnvelope {
	type: "StasisStart";
	channel: AsteriskChannel;
	args: string[];
	replace_channel?: AsteriskChannel;
}

/** The channel left Stasis - either hung up, or handed back to the dialplan by us. */
export interface AriStasisEndEvent extends AriEventEnvelope {
	type: "StasisEnd";
	channel: AsteriskChannel;
}

export interface AriChannelCreatedEvent extends AriEventEnvelope {
	type: "ChannelCreated";
	channel: AsteriskChannel;
}

export interface AriChannelStateChangeEvent extends AriEventEnvelope {
	type: "ChannelStateChange";
	channel: AsteriskChannel;
}

/** The far end asked to hang up. The channel still exists at this point. */
export interface AriChannelHangupRequestEvent extends AriEventEnvelope {
	type: "ChannelHangupRequest";
	channel: AsteriskChannel;
	cause?: number;
	soft?: boolean;
}

/** The channel is gone. This is the reliable place to finalise a call row. */
export interface AriChannelDestroyedEvent extends AriEventEnvelope {
	type: "ChannelDestroyed";
	channel: AsteriskChannel;
	cause: number;
	cause_txt: string;
}

export interface AriChannelDtmfReceivedEvent extends AriEventEnvelope {
	type: "ChannelDtmfReceived";
	channel: AsteriskChannel;
	digit: string;
	duration_ms?: number;
}

/**
 * A channel variable changed. `channel` is optional because Asterisk emits
 * ChannelVarset for global variables too, with no channel attached.
 */
export interface AriChannelVarsetEvent extends AriEventEnvelope {
	type: "ChannelVarset";
	channel?: AsteriskChannel;
	variable: string;
	value: string;
}

export interface AriPlaybackStartedEvent extends AriEventEnvelope {
	type: "PlaybackStarted";
	playback: AsteriskPlayback;
}

export interface AriPlaybackFinishedEvent extends AriEventEnvelope {
	type: "PlaybackFinished";
	playback: AsteriskPlayback;
}

export interface AriBridgeCreatedEvent extends AriEventEnvelope {
	type: "BridgeCreated";
	bridge: AsteriskBridge;
}

export interface AriBridgeDestroyedEvent extends AriEventEnvelope {
	type: "BridgeDestroyed";
	bridge: AsteriskBridge;
}

export interface AriChannelEnteredBridgeEvent extends AriEventEnvelope {
	type: "ChannelEnteredBridge";
	bridge: AsteriskBridge;
	channel: AsteriskChannel;
}

export interface AriChannelLeftBridgeEvent extends AriEventEnvelope {
	type: "ChannelLeftBridge";
	bridge: AsteriskBridge;
	channel: AsteriskChannel;
}

/**
 * Outbound dial progress. Used by the transfer flow to tell "operator is
 * ringing" apart from "operator answered" and from "nobody picked up".
 */
export interface AriDialEvent extends AriEventEnvelope {
	type: "Dial";
	caller?: AsteriskChannel;
	peer: AsteriskChannel;
	dialstring?: string;
	/** "" while ringing, then "ANSWER" | "BUSY" | "NOANSWER" | "CANCEL" | "CONGESTION" | "CHANUNAVAIL". */
	dialstatus: string;
	forward?: string;
	forwarded?: AsteriskChannel;
}

/** Every ARI event this layer understands, discriminated on `type`. */
export type AriEvent =
	| AriStasisStartEvent
	| AriStasisEndEvent
	| AriChannelCreatedEvent
	| AriChannelStateChangeEvent
	| AriChannelHangupRequestEvent
	| AriChannelDestroyedEvent
	| AriChannelDtmfReceivedEvent
	| AriChannelVarsetEvent
	| AriPlaybackStartedEvent
	| AriPlaybackFinishedEvent
	| AriBridgeCreatedEvent
	| AriBridgeDestroyedEvent
	| AriChannelEnteredBridgeEvent
	| AriChannelLeftBridgeEvent
	| AriDialEvent;

export type AriEventName = AriEvent["type"];

/** Narrows the union to one event by name: `AriEventOf<"StasisStart">`. */
export type AriEventOf<TName extends AriEventName> = Extract<AriEvent, { type: TName }>;

// ===========================================
// ARI client
// ===========================================

/** Target for continueInDialplan - where Asterisk resumes after Stasis hands the channel back. */
export interface AriContinueTarget {
	context: string;
	extension: string;
	priority?: number;
	label?: string;
}

/**
 * Options for originating a new channel.
 *
 * Supply `extension` (with `context`) to drop the new channel into the
 * dialplan - that is how the AI transfer and click-to-call flows ring an
 * operator. Omit it to have the new channel enter our own Stasis application
 * instead, in which case `appArgs` is passed through as the Stasis arguments.
 *
 * The second form is what an AI-answered outbound call needs and what
 * placeOutboundCall() uses: the person who picks up lands in the same Stasis
 * application an inbound caller lands in, so one orchestrator serves both
 * directions. `appArgs` carries the token that ties the answered channel back to
 * the campaign row that asked for the call.
 */
export interface AriOriginateOptions {
	/** e.g. "PJSIP/101". */
	endpoint: string;
	context?: string;
	extension?: string;
	priority?: number;
	callerId?: string;
	/** Seconds to wait for an answer. Asterisk's default is 30. */
	timeout?: number;
	variables?: Record<string, string>;
	appArgs?: string;
	/**
	 * Choose the new channel's id instead of letting Asterisk assign one.
	 *
	 * ARI accepts this on POST /channels, and a campaign dial needs it: the ONLY
	 * evidence about a phone nobody picked up is the ChannelDestroyed event and its
	 * Q.850 cause, and that event can arrive before the originate HTTP response
	 * does - the event socket and the REST call are different connections. Knowing
	 * the id before the dial starts is what lets the orchestrator recognise the
	 * hangup of a channel it has never seen a snapshot of, instead of racing to
	 * learn the id it needed a moment ago.
	 */
	channelId?: string;
}

export interface AriCreateBridgeOptions {
	/** ARI bridge type; "mixing" unless you know you want something else. */
	type?: string;
	/** Pre-chosen id, so the caller can correlate BridgeCreated without waiting for the response. */
	bridgeId?: string;
}

/**
 * Options for an ARI live recording.
 *
 * `name` must not contain "/" - ARI rejects that as path traversal. The file
 * lands in Asterisk's own recording directory, which the container symlinks
 * onto the bind-mounted recordings directory so the backend can read it.
 */
export interface AriRecordOptions {
	/** Base filename without extension. The call id is the natural choice. */
	name: string;
	/** "wav" unless you have a reason; it is what the dashboard player expects. */
	format?: string;
	maxDurationSeconds?: number;
	maxSilenceSeconds?: number;
	/** "fail" | "overwrite" | "append". Defaults to overwrite so a retried call is not blocked. */
	ifExists?: string;
	beep?: boolean;
}

/**
 * Everything the voice layer is allowed to ask of Asterisk.
 *
 * Kept as an interface so the orchestrator can be unit-tested against a fake
 * and so a future move off ARI does not ripple outward.
 */
export interface AriClient {
	answer(channelId: string): Promise<void>;
	hangup(channelId: string, reason?: string): Promise<void>;
	ringing(channelId: string): Promise<void>;
	setVariable(channelId: string, name: string, value: string): Promise<void>;
	/** Resolves to null when the variable is unset - Asterisk answers 404 for that. */
	getVariable(channelId: string, name: string): Promise<string | null>;
	continueInDialplan(channelId: string, target: AriContinueTarget): Promise<void>;
	/** Resolves to the playback id, which PlaybackFinished carries back. */
	playback(channelId: string, media: string): Promise<string>;
	stopPlayback(playbackId: string): Promise<void>;
	/**
	 * Record the channel through ARI, resolving to the recording name.
	 *
	 * NOT used for call recording, and deliberately so: a channel carrying an
	 * ARI live recording cannot be added to a bridge (Asterisk answers
	 * "409 Channel currently recording"), which breaks the AI-to-human transfer.
	 * Call recording therefore goes through MixMonitor - from [ai-bridge] on the
	 * realtime path, and over AMI on the fallback path. This method is kept for
	 * bounded, non-bridged captures such as recording a voicemail-style prompt.
	 */
	record(channelId: string, options: AriRecordOptions): Promise<string>;
	/** Stop a live recording. Tolerates an already-finished recording. */
	stopRecording(recordingName: string): Promise<void>;
	startMoh(channelId: string): Promise<void>;
	stopMoh(channelId: string): Promise<void>;
	originate(options: AriOriginateOptions): Promise<AsteriskChannel>;
	createBridge(options?: AriCreateBridgeOptions): Promise<AsteriskBridge>;
	addToBridge(bridgeId: string, channelIds: string[]): Promise<void>;
	removeFromBridge(bridgeId: string, channelIds: string[]): Promise<void>;
	destroyBridge(bridgeId: string): Promise<void>;
	listChannels(): Promise<AsteriskChannel[]>;
	/** Resolves to null when the channel no longer exists. */
	getChannel(channelId: string): Promise<AsteriskChannel | null>;
	info(): Promise<Record<string, unknown>>;
}

// ===========================================
// Outbound campaigns
// ===========================================

/**
 * What kind of outbound call this is.
 *
 * A closed set rather than free text because it changes BEHAVIOUR, not just a
 * label: an advertising call has to offer a way out in its first breath, while a
 * reminder about something the person really did with the business must not
 * sound like one. The prompt builder switches on this, so a value it does not
 * recognise would silently produce a call with no shape at all.
 *
 * "other" is the honest answer for a campaign that is none of the rest, and it
 * is also what an unrecognised stored value resolves to (see
 * resolveOutboundCampaignKind) - a campaign row written by a newer dashboard
 * must still be dialable by this code rather than failing at the last moment,
 * with the person's phone already ringing.
 */
export type OutboundCampaignKind = "reminder" | "sales" | "advertising" | "survey" | "other";

/**
 * Why we are ringing this person, and what the list says about them.
 *
 * This is the whole of what the agent knows about the campaign. It is passed
 * into the prompt builder, which composes the opening line from it and writes
 * the outbound half of the instructions around it - the business's identity,
 * knowledge base and house rules still come from the profile exactly as they do
 * on an inbound call.
 *
 * Nothing here is trusted as safe prose: `purpose`, `openingLine`, `script`,
 * `notes` and every value in `variables` are owner-entered (often imported from a
 * spreadsheet), so the prompt builder caps and normalises them the same way it
 * treats customInstructions.
 */
export interface OutboundCallPurpose {
	kind: OutboundCampaignKind;
	/** Campaign name, for the log and the audit trail. Never spoken to the person. */
	campaignName: string | null;
	/**
	 * Why this person is being called, in the words the business wrote.
	 *
	 * Written to be SAID: the greeting quotes it (or a frame around it) as the
	 * reason, and the instructions repeat it as the goal of the call. One or two
	 * sentences.
	 */
	purpose: string;
	/**
	 * The exact first sentence, when the business wrote one. Spoken verbatim.
	 *
	 * The platform still guarantees the business is named in it - see
	 * buildGreeting - because a campaign that hides who is calling is a scam call
	 * whatever it was meant to be.
	 */
	openingLine: string | null;
	/**
	 * Extra instructions for THIS campaign, in the owner's words - the talking
	 * points, the one question the survey exists to ask, what to say if they ask
	 * about the price.
	 *
	 * Separate from `purpose` because the two are read at different moments and by
	 * different rules: `purpose` is one sentence that gets SPOKEN in the opening
	 * line, while this is guidance for the rest of the conversation and is never
	 * read out. Separate from `notes` because `notes` is per-lead data off a
	 * spreadsheet that the agent is told may be wrong, and instructions from the
	 * business are not.
	 */
	script: string | null;
	/** The person's name as the list carried it, when it carried one. */
	leadName: string | null;
	/**
	 * Per-lead values from the import, e.g. { buyurtma: "AB-12", summa: "250 000" }.
	 *
	 * Keys are the owner's own column names, so they are quoted into the prompt
	 * as-is and the agent is told to use them only where they fit the reason.
	 */
	variables: Record<string, string>;
	/** Free-text notes about this lead from the import. */
	notes: string | null;
}

// ===========================================
// Voice session
// ===========================================

/** Matches the transcript_role enum on call_transcripts. */
export type TranscriptRole = "caller" | "agent" | "system";

/**
 * What the provider is told about the call before the first audio frame.
 *
 * This is the CRM context the agent gets to personalise its greeting: who is
 * calling, whether we have spoken before, and what they last complained
 * about. Built by the orchestrator from `contacts`, `calls` and `tickets`.
 */
export interface VoiceSessionContext {
	/** calls.id - also the AudioSocket UUID, which is what ties audio to a CRM row. */
	callId: string;
	channelId: string;
	/**
	 * The other party's number: who rang us on an inbound call, and who WE rang on
	 * an outbound one. One field for both directions because everything that reads
	 * it - contact matching, the prompt, calls.caller_number - wants the same
	 * thing: the person at the far end.
	 */
	callerNumber: string;
	/** BCP-47-ish short code as configured in AI_AGENT_LANGUAGE, e.g. "uz". */
	language: string;
	contact: {
		id: string;
		firstName: string | null;
		lastName: string | null;
		/** contacts.address jsonb - { tuman, kocha, uy } in practice. */
		address: unknown;
	} | null;
	isReturningCaller: boolean;
	previousCallCount: number;
	/** Newest first. `createdAt` is an ISO-8601 string so providers can embed it in a prompt as-is. */
	recentTickets: Array<{
		id: string;
		subject: string;
		status: string;
		createdAt: string;
	}>;
	/**
	 * Set ONLY when the platform placed this call itself, as part of a campaign.
	 *
	 * Absent or null means inbound, which is what keeps every existing caller,
	 * provider and test on exactly the path they were on before campaigns existed:
	 * the prompt builder adds the outbound half of the instructions when this is
	 * present and changes nothing at all when it is not. Optional rather than
	 * nullable so no existing construction site has to be edited.
	 */
	campaign?: OutboundCallPurpose | null;
}

/**
 * Callbacks a provider fires. The orchestrator owns all of them; the provider
 * never writes to the database or to Asterisk itself.
 */
export interface VoiceProviderHandlers {
	/** Session negotiated and configured - safe to start pushing caller audio. */
	onReady(): void;
	/** Audio for the caller, 8 kHz signed-linear 16-bit mono (what AudioSocket expects). */
	onAudio(slin8k: Buffer): void;
	onTranscript(transcript: {
		role: TranscriptRole;
		content: string;
		isFinal: boolean;
		startMs?: number;
		endMs?: number;
	}): void;
	/** Return value is serialised back to the model as the tool result. */
	onToolCall(call: {
		name: string;
		toolCallId: string;
		args: Record<string, unknown>;
	}): Promise<unknown>;
	/** The caller started talking while the agent was still speaking. */
	onInterruption(): void;
	/**
	 * What the provider's own server heard from the caller.
	 *
	 * Optional, and separate from onTranscript on purpose: OpenAI reports it
	 * mid-turn from its VAD, while every other signal arrives at a turn BOUNDARY,
	 * after the input buffer is committed.
	 *
	 * Nothing depends on a provider implementing it, and nothing should: Gemini
	 * Live sends no mid-turn event at all, which is why the platform measures the
	 * caller's own frames itself (audiosocket.ts, CallerVoiceActivity - the single
	 * detector). This stays because a server that DID hear something is telling the
	 * truth, and a true signal is worth acting on.
	 */
	onCallerSpeech?(): void;
	onUsage(usage: {
		promptTokens?: number;
		completionTokens?: number;
		/**
		 * Prompt tokens served from the provider's cache on this turn.
		 *
		 * Realtime re-reads the whole session prefix every turn, so the prompt total
		 * is dominated by the instructions repeated once per turn. Cached tokens cost
		 * roughly a tenth of fresh ones, so this is what separates "the prompt is too
		 * long" from "the cache is not being hit" - and the two need opposite fixes.
		 */
		cachedTokens?: number;
		/**
		 * How `cachedTokens` itself split across modalities, for the providers that
		 * say. OpenAI Realtime reports it; Gemini Live does not, and leaving these
		 * undefined is what tells the cost module to apportion instead of pretending
		 * the cached prefix was all text or all audio.
		 */
		cachedAudioTokens?: number;
		cachedTextTokens?: number;
		/** Prompt tokens that were audio rather than text. */
		inputAudioTokens?: number;
		/**
		 * Prompt tokens that were text.
		 *
		 * Reported rather than derived from `promptTokens - inputAudioTokens`: the
		 * prompt total also contains the cached prefix, so subtracting audio from it
		 * yields neither marginal. Both are needed to apportion the cached tokens
		 * across modalities without guessing.
		 */
		inputTextTokens?: number;
		/** Completion tokens spent on generated speech - the priciest line item. */
		outputAudioTokens?: number;
		/** Completion tokens spent on text. With outputAudioTokens this sums to the completion total. */
		outputTextTokens?: number;
	}): void;
	/**
	 * Input transcription billed separately from the session itself.
	 *
	 * Kept apart from onUsage because it is a different model on a different price
	 * list (gpt-4o-transcribe, not the realtime model) and only one provider has
	 * it: Gemini transcribes inside the session with no separate charge. Optional
	 * so a provider that never bills it - and every fake provider in the tests -
	 * still satisfies the contract.
	 */
	onTranscriptionUsage?(usage: {
		audioTokens?: number;
		textTokens?: number;
		/** Present when the provider bills transcription by wall-clock audio rather than tokens. */
		seconds?: number;
		model?: string;
	}): void;
	onError(error: Error): void;
	onClose(reason: string): void;
}

/** Counters persisted onto ai_sessions when the call ends. */
export interface VoiceProviderStats {
	inputAudioMs: number;
	outputAudioMs: number;
	interruptions: number;
}

/**
 * A speech-to-speech backend. `openai-realtime` is the first implementation;
 * the orchestrator falls back to a scripted provider when a provider throws
 * VoiceProviderUnavailableError from start().
 */
export interface VoiceProvider {
	readonly name: string;
	/**
	 * The model id this instance actually opened the session with.
	 *
	 * Optional so the scripted fallback and the fakes in the test suite still
	 * satisfy the contract. Without it ai_sessions.model can only record what the
	 * environment holds, which on a two-provider deployment labels every Gemini
	 * call with the OpenAI model - and a per-model cost figure built on that is a
	 * lie rather than an estimate.
	 */
	readonly model?: string;
	/**
	 * The voice this instance actually opened the session with.
	 *
	 * Only meaningful after `start()` has resolved, because that is where a
	 * provider reconciles the profile, the stored setting and its own fallback.
	 * Reconstructing it from the profile instead recorded the voice the caller was
	 * meant to hear rather than the one they did - and the two diverge the moment a
	 * voice is saved on the AI assistant page or a name is rejected and defaulted.
	 */
	readonly voice?: string;
	start(context: VoiceSessionContext, handlers: VoiceProviderHandlers): Promise<void>;
	/** Caller audio, 8 kHz signed-linear 16-bit mono. */
	pushAudio(slin8k: Buffer): void;
	/** Speak a line of text out of band (greeting, hold message, transfer notice). */
	say(text: string): void;
	/** Abandon the in-flight response - used on barge-in and before a transfer. */
	cancelResponse(): void;
	/**
	 * Stop letting caller noise cancel the agent's turn, for the rest of the call.
	 *
	 * Used before the closing line: the platform speaks it and then waits for the
	 * audio to drain, so a cough over the goodbye must not abandon the very response
	 * being waited for. Optional - a provider with no barge-in of its own has
	 * nothing to suppress.
	 */
	suppressBargeIn?(): void;
	sendToolResult(toolCallId: string, result: unknown): void;
	stop(reason: string): Promise<void>;
	stats(): VoiceProviderStats;
}

/**
 * Thrown when a provider cannot serve this call at all: no API key, no model
 * access, handshake rejected, network unreachable.
 *
 * This is the fallback signal. It is deliberately a distinct type so the
 * orchestrator can tell "this backend is not available, use another one" apart
 * from a bug, and so a missing OpenAI entitlement degrades the call to the
 * scripted flow instead of dropping it.
 */
export class VoiceProviderUnavailableError extends Error {
	public readonly provider: string;
	/** Narrows the ES2022 `Error.cause` (typed `unknown`) to what this layer ever passes in. */
	public declare readonly cause?: Error;

	constructor(provider: string, message: string, cause?: Error) {
		super(message, { cause });
		this.name = "VoiceProviderUnavailableError";
		this.provider = provider;

		Error.captureStackTrace(this, this.constructor);
	}
}
