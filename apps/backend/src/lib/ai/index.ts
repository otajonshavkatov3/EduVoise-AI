/**
 * AI voice layer barrel.
 *
 * The whole speech path, in dependency order:
 *
 *   audiosocket  Asterisk dials in over TCP and streams slin 8 kHz both ways.
 *   codec        slin8k <-> G.711 u-law, and 8 kHz <-> 24 kHz when a provider
 *                needs it. Pure functions.
 *   prompts      the receptionist's system instructions and greeting, composed
 *                from the business's own ai_agent_profiles row and knowledge base.
 *   tools        the eight function-calling tools, in GA Realtime shape, each
 *                with a zod validator for the arguments the model returns.
 *   providers    openai-realtime (speech to speech) and fallback-ivr (no paid
 *                API, hands the caller to a human), chosen by provider-factory.
 *   elevenlabs   text to speech for the lines whose wording is fixed. Not a
 *                provider: it renders audio the orchestrator pushes into the
 *                same AudioSocket queue the model's own speech goes through.
 *   gemini-tts   one-shot Google TTS in the same prebuilt voices the Live model
 *                uses, so the dashboard's voice picker can be listened to. Never
 *                on the call path.
 *
 * The contract types are re-exported here so a consumer can import a provider
 * and the interfaces it satisfies from one place.
 */

export type {
	TranscriptRole,
	VoiceProvider,
	VoiceProviderHandlers,
	VoiceProviderStats,
	VoiceSessionContext,
} from "@/lib/telephony/contracts";
export { VoiceProviderUnavailableError } from "@/lib/telephony/contracts";
export type {
	AudioSocketAddress,
	AudioSocketErrorKind,
	AudioSocketLogger,
	AudioSocketServerEvents,
	AudioSocketServerOptions,
	AudioSocketSession,
	AudioSocketSessionStats,
	CallerVoiceActivityStats,
} from "./audiosocket";
export {
	AUDIOSOCKET_FRAME_BYTES,
	AUDIOSOCKET_FRAME_MS,
	AUDIOSOCKET_HEADER_BYTES,
	AUDIOSOCKET_MAX_PAYLOAD_BYTES,
	AUDIOSOCKET_SAMPLE_RATE,
	AUDIOSOCKET_UUID_BYTES,
	AudioSocketError,
	AudioSocketPacketType,
	AudioSocketServer,
	CALLER_VOICE_FLOOR_RMS,
	CALLER_VOICE_GAP_FRAMES,
	CALLER_VOICE_MIN_NOISE_RMS,
	CALLER_VOICE_NOISE_FALL,
	CALLER_VOICE_NOISE_RISE,
	CALLER_VOICE_OVER_NOISE,
	CALLER_VOICE_RUN_FRAMES,
	CallerVoiceActivity,
	encodeAudioSocketPacket,
	formatAudioSocketUuid,
	silentAudioSocketLogger,
	slinRms,
} from "./audiosocket";
export type {
	AgentVoiceChain,
	AgentVoiceChainOptions,
	BiquadCoefficients,
	Resampler,
} from "./codec";
export {
	BYTES_PER_SAMPLE,
	biquadMagnitudeDb,
	clampInt16,
	createAgentVoiceChain,
	createDownsampler24kTo8k,
	createUpsampler8kTo24k,
	DOWNSAMPLE_CUTOFF_HZ,
	DOWNSAMPLE_FIR_TAPS,
	DOWNSAMPLE_GROUP_DELAY_24K,
	designPeakingBiquad,
	downsample24kTo8k,
	INT16_MAX,
	INT16_MIN,
	LIMITER_CEILING,
	LIMITER_LOOKAHEAD_SAMPLES,
	MU_LAW_SILENCE,
	muLawDecode,
	muLawDecodeSample,
	muLawEncode,
	muLawEncodeSample,
	OUTPUT_GAIN_MAX_DB,
	PRESENCE_CENTRE_HZ,
	PRESENCE_MAX_DB,
	PRESENCE_Q,
	RESAMPLE_FACTOR,
	RESAMPLE_ROUND_TRIP_DELAY_8K,
	readInt16LEArray,
	upsample8kTo24k,
	writeInt16LEArray,
} from "./codec";
export type { ElevenLabsOptions, RenderedSpeech } from "./elevenlabs";
export { isElevenLabsConfigured, renderCached, renderStream } from "./elevenlabs";
export type { FallbackIvrProviderOptions } from "./fallback-ivr";
export {
	createFallbackIvrProvider,
	FALLBACK_IVR_PROVIDER_NAME,
	FALLBACK_TRANSFER_REASON,
} from "./fallback-ivr";
export type {
	GeminiLiveProviderOptions,
	GeminiLiveTuning,
	GeminiVoiceOption,
} from "./gemini-live";
export {
	createGeminiLiveProvider,
	GEMINI_DEFAULT_VOICE,
	GEMINI_LIVE_PROVIDER_NAME,
	GEMINI_VOICE_CATALOG,
	getGeminiLiveRuntime,
	getGeminiLiveTuning,
	isGeminiLiveConfigured,
	KNOWN_GEMINI_VOICES,
	phoneClarityLabel,
	resolveGeminiVoice,
} from "./gemini-live";
export type { VoiceSample } from "./gemini-tts";
export {
	clearVoiceSampleCache,
	GEMINI_TTS_MODEL,
	isGeminiTtsConfigured,
	MAX_SAMPLE_CHARS,
	pcmToWav,
	sampleRateFromMime,
	synthesizeVoiceSample,
	VoiceSampleError,
	voiceSampleCacheKey,
} from "./gemini-tts";
export type {
	OpenAiRealtimeProviderOptions,
	RealtimeProbeOptions,
	RealtimeProbeResult,
} from "./openai-realtime";
export {
	createOpenAiRealtimeProvider,
	OPENAI_REALTIME_PROVIDER_NAME,
	probeOpenAiRealtime,
} from "./openai-realtime";
export type { AgentDialectId, AgentDialectOption, AgentPromptContext } from "./prompts";
export {
	AGENT_DIALECTS,
	buildGreeting,
	buildKnowledgeMissGuidance,
	buildSystemInstructions,
	buildToolAcknowledgement,
	DEFAULT_AGENT_DIALECT,
	formatCallerName,
	formatKnownAddress,
	formatSayDirective,
	resolveAgentDialect,
	SAY_DIRECTIVE_MARKER,
	TOOL_FAILURE_GUIDANCE,
	TOOL_RESULT_GUIDANCE,
	unconfiguredAgentProfile,
} from "./prompts";
export type {
	ProbeProviderHealthOptions,
	ResolveVoiceProviderOptions,
	VoiceProviderHealth,
} from "./provider-factory";
export {
	isGeminiVoiceSelected,
	probeProviderHealth,
	resetVoiceProviderHealthCache,
	resolveVoiceProvider,
	selectedVoiceProviderName,
} from "./provider-factory";
export type {
	AddNoteArgs,
	BookAppointmentArgs,
	CreateFollowUpArgs,
	CreateTicketArgs,
	EndCallArgs,
	OutboundCallOutcome,
	RealtimeToolDefinition,
	RecordCallOutcomeArgs,
	SaveContactDetailsArgs,
	SearchKnowledgeBaseArgs,
	TicketPriority,
	ToolDefinitionOptions,
	ToolName,
	ToolParameterSchema,
	ToolParametersSchema,
	ToolValidationResult,
	TransferToHumanArgs,
} from "./tools";
export {
	AddNoteArgsSchema,
	BookAppointmentArgsSchema,
	buildToolDefinitions,
	CreateFollowUpArgsSchema,
	CreateTicketArgsSchema,
	EndCallArgsSchema,
	FALLBACK_TICKET_CATEGORIES,
	isToolName,
	normaliseTicketCategories,
	OUTBOUND_CALL_OUTCOMES,
	OUTBOUND_TOOL_DEFINITIONS,
	RecordCallOutcomeArgsSchema,
	resolveOutboundOutcome,
	resolveTicketCategory,
	resolveTicketPriority,
	SaveContactDetailsArgsSchema,
	SearchKnowledgeBaseArgsSchema,
	TICKET_PRIORITIES,
	TOOL_DEFINITIONS,
	TOOL_NAMES,
	TOOL_VALIDATORS,
	TransferToHumanArgsSchema,
	toolsForCall,
	validateToolArguments,
} from "./tools";
