/**
 * Business-configurable AI agent.
 *
 * The platform is sold to business owners who point their phone line at it, so
 * everything the agent says has to come from configuration and from the
 * knowledge base — not from code. This module is the boundary the prompt builder
 * and the orchestrator read through.
 */
export type { KnowledgeHit } from "./knowledge";
export {
	formatEntriesForPrompt,
	getPrimedEntries,
	searchKnowledgeBase,
} from "./knowledge";
export type { ActiveAgentProfile } from "./profile";
export {
	activateProfile,
	DEFAULT_PROFILE,
	ensureDefaultProfile,
	getActiveAgentProfile,
	invalidateAgentProfileCache,
	isWithinBusinessHours,
} from "./profile";
