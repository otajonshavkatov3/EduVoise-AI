/**
 * Drizzle relations for the outbound campaign tables.
 *
 * Separate file for the same reason aiVoiceRelations.ts is separate: Drizzle
 * allows one relations() declaration per table, relations.ts already owns
 * users/calls/tickets/contacts, and these point outward from the new tables only.
 * Querying from the existing side (calls -> campaign lead) is done with an
 * explicit join in the handlers, which keeps relations.ts free of edits.
 */
import { relations } from "drizzle-orm";

import { aiAgentProfiles } from "./aiAgent";
import { calls } from "./callTicketAi";
import { callCampaigns, campaignCallAttempts, campaignLeads, doNotCallList } from "./campaigns";
import { contacts } from "./contacts";
import { users } from "./users";

export const callCampaignsRelations = relations(callCampaigns, ({ one, many }) => ({
	agentProfile: one(aiAgentProfiles, {
		fields: [callCampaigns.agentProfileId],
		references: [aiAgentProfiles.id],
	}),
	creator: one(users, {
		fields: [callCampaigns.createdBy],
		references: [users.id],
	}),
	starter: one(users, {
		fields: [callCampaigns.startedBy],
		references: [users.id],
	}),
	leads: many(campaignLeads),
	attempts: many(campaignCallAttempts),
}));

export const campaignLeadsRelations = relations(campaignLeads, ({ one, many }) => ({
	campaign: one(callCampaigns, {
		fields: [campaignLeads.campaignId],
		references: [callCampaigns.id],
	}),
	contact: one(contacts, {
		fields: [campaignLeads.contactId],
		references: [contacts.id],
	}),
	call: one(calls, {
		fields: [campaignLeads.callId],
		references: [calls.id],
	}),
	attempts: many(campaignCallAttempts),
}));

export const campaignCallAttemptsRelations = relations(campaignCallAttempts, ({ one }) => ({
	campaign: one(callCampaigns, {
		fields: [campaignCallAttempts.campaignId],
		references: [callCampaigns.id],
	}),
	lead: one(campaignLeads, {
		fields: [campaignCallAttempts.leadId],
		references: [campaignLeads.id],
	}),
	call: one(calls, {
		fields: [campaignCallAttempts.callId],
		references: [calls.id],
	}),
}));

export const doNotCallListRelations = relations(doNotCallList, ({ one }) => ({
	call: one(calls, {
		fields: [doNotCallList.callId],
		references: [calls.id],
	}),
	addedBy: one(users, {
		fields: [doNotCallList.createdBy],
		references: [users.id],
	}),
}));
