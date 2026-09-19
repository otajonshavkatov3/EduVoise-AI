/**
 * Telephony layer barrel.
 *
 * The CRM side of the AI voice feature, in dependency order:
 *
 *   contracts        types and error classes only - no runtime, no imports.
 *   contact-matcher  phone normalisation and contact lookup / creation, using
 *                    the same rules as the legacy FreePBX webhook.
 *   crm-writer       every database write an AI-handled call can cause, each
 *                    idempotent where the data model allows it.
 *   transfer         AI to human handover, via an ARI bridge or an AMI redirect
 *                    depending on where the caller's channel actually is.
 *   call-orchestrator the state machine that ties Asterisk, the AudioSocket
 *                    audio path, the voice provider and all of the above
 *                    together, and the process-wide singleton accessor.
 *
 * Import from here rather than reaching into the individual modules: the split
 * between them is an implementation detail, and `getCallOrchestrator()` is the
 * one entry point the HTTP layer and the server bootstrap need.
 */

export type {
	CallOrchestratorOptions,
	CallSummariser,
	CallSummary,
	CallSummaryInput,
	FailedTransferOutcome,
	LiveCallAnalysisEvent,
	LiveCallContact,
	LiveCallEndedEvent,
	LiveCallEvent,
	LiveCallEventType,
	LiveCallSnapshot,
	LiveCallStartedEvent,
	LiveCallStatus,
	LiveCallTranscriptEvent,
	LiveCallTransferEvent,
	LiveCallUpdatedEvent,
	TransferOutcome,
	TransferPhase,
} from "./call-orchestrator";
export {
	CallOrchestrator,
	classifyAgentStall,
	classifyFailedTransfer,
	getCallOrchestrator,
	LIVE_CALL_EVENTS,
	placeOutboundCall,
	resetCallOrchestrator,
	summariseCallWithOpenAi,
} from "./call-orchestrator";
export type {
	ContactAddress,
	ContactHistory,
	ContactHistoryOptions,
	ContactHistoryTicket,
	ContactMatch,
} from "./contact-matcher";
export {
	canonicalisePhone,
	findAnyContactByPhone,
	findContactByPhone,
	findOrCreateContact,
	getContactHistory,
	getPhoneVariations,
	isUniqueViolation,
} from "./contact-matcher";
export type {
	AriClient,
	AriContinueTarget,
	AriCreateBridgeOptions,
	AriEvent,
	AriEventName,
	AriEventOf,
	AriOriginateOptions,
	AsteriskBridge,
	AsteriskCallerId,
	AsteriskChannel,
	AsteriskDialplanCep,
	AsteriskPlayback,
	OutboundCallPurpose,
	OutboundCampaignKind,
	TranscriptRole,
	VoiceProvider,
	VoiceProviderHandlers,
	VoiceProviderStats,
	VoiceSessionContext,
} from "./contracts";
export { VoiceProviderUnavailableError } from "./contracts";
export type {
	AddNoteInput,
	AiSessionPatch,
	AiSessionStatus,
	AiStatus,
	AppendTranscriptInput,
	CallDirection,
	CallStatus,
	ContactDetailsPatch,
	CreateAiSessionInput,
	CreateAiSessionResult,
	CreateBookingInput,
	CreateBookingResult,
	CreateFollowUpInput,
	CreateFollowUpResult,
	CreateInboundCallInput,
	CreateInboundCallResult,
	CreateTicketFromCallInput,
	CreateTicketFromCallResult,
	FinishAiSessionInput,
	FinishAiSessionResult,
	MarkCallEndedInput,
	MarkCallEndedResult,
	NoteAuthorType,
	SaveRecordingInput,
	SaveRecordingResult,
	Sentiment,
	TicketPriority,
	TranscriptTextResult,
	UpsertContactDetailsResult,
	WriteAiAnalysisInput,
	WriteAiAnalysisResult,
} from "./crm-writer";
export {
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
	resolveOperatorProfileIdByExtension,
	resolveSystemActorUserId,
	saveRecording,
	setCallContact,
	setCallOperator,
	updateAiSession,
	upsertContactDetails,
	writeAiAnalysis,
} from "./crm-writer";
export type {
	InboundTenantResolution,
	InboundTenantSource,
	TenantBearingChannel,
} from "./inbound-tenant";
// The answer to "whose call is this" on an inbound channel. Exported so the Asterisk
// phase can generate a dialplan against the same contract it reads.
export { endpointOf, resolveInboundTenant, slugFromChannel } from "./inbound-tenant";
export type {
	ChannelOutcomeVerdict,
	OutboundCallPlaced,
	OutboundCallRefused,
	OutboundCallRequest,
	OutboundChannelOutcome,
	OutboundDialerHooks,
	OutboundDialingDescription,
	OutboundDialRefusal,
	OutboundEndpointResult,
	OutboundOptOutEntry,
	OutboundOutcome,
	OutboundOutcomeEvent,
	PlaceOutboundCallResult,
} from "./outbound";
export {
	classifyHangupCause,
	DIAL_PATTERN_TOKEN,
	describeOutboundDialing,
	getOutboundDialerHooks,
	isDoNotCallNumber,
	isOptOutOutcome,
	isTrunkConfigured,
	listOutboundCampaignKinds,
	OUTBOUND_CHANNEL_OUTCOMES,
	OUTBOUND_OUTCOMES,
	reportOutboundOptOut,
	reportOutboundOutcome,
	resolveOutboundCampaignKind,
	resolveOutboundEndpoint,
	setOutboundDialerHooks,
	toDialableDigits,
	trunkFromDialPattern,
} from "./outbound";
export type {
	TransferResult,
	TransferStatus,
	TransferStrategy,
	TransferTarget,
	TransferToHumanInput,
} from "./transfer";
export { chooseTransferTarget, listTransferTargets, transferToHuman } from "./transfer";
