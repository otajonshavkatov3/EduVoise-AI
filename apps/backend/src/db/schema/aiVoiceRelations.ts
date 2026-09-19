/**
 * Drizzle relations for the AI voice tables.
 *
 * Kept in a separate file from relations.ts on purpose: that file already
 * declares relations() for users/calls/tickets/contacts, and Drizzle allows
 * only one declaration per table. Declaring the new relations here, pointing
 * outward from the new tables, leaves every existing relation untouched.
 *
 * These are one-directional (new table -> existing table). Querying from the
 * existing side (e.g. calls.transcripts) is done with an explicit join in the
 * handlers instead, which keeps relations.ts free of edits.
 */
import { relations } from "drizzle-orm";
import {
	aiSessions,
	bookings,
	callNotes,
	callRecordings,
	callTranscripts,
	callTransfers,
	followUpTasks,
	sipExtensions,
} from "./aiVoice";
import { calls, tickets } from "./callTicketAi";
import { contacts } from "./contacts";
import { operatorProfiles } from "./operatorProfiles";
import { users } from "./users";

export const aiSessionsRelations = relations(aiSessions, ({ one, many }) => ({
	call: one(calls, {
		fields: [aiSessions.callId],
		references: [calls.id],
	}),
	transcripts: many(callTranscripts),
	transfers: many(callTransfers),
}));

export const callTranscriptsRelations = relations(callTranscripts, ({ one }) => ({
	call: one(calls, {
		fields: [callTranscripts.callId],
		references: [calls.id],
	}),
	aiSession: one(aiSessions, {
		fields: [callTranscripts.aiSessionId],
		references: [aiSessions.id],
	}),
}));

export const callRecordingsRelations = relations(callRecordings, ({ one }) => ({
	call: one(calls, {
		fields: [callRecordings.callId],
		references: [calls.id],
	}),
}));

export const callTransfersRelations = relations(callTransfers, ({ one }) => ({
	call: one(calls, {
		fields: [callTransfers.callId],
		references: [calls.id],
	}),
	aiSession: one(aiSessions, {
		fields: [callTransfers.aiSessionId],
		references: [aiSessions.id],
	}),
	toOperator: one(operatorProfiles, {
		fields: [callTransfers.toOperatorId],
		references: [operatorProfiles.id],
	}),
}));

export const callNotesRelations = relations(callNotes, ({ one }) => ({
	call: one(calls, {
		fields: [callNotes.callId],
		references: [calls.id],
	}),
	ticket: one(tickets, {
		fields: [callNotes.ticketId],
		references: [tickets.id],
	}),
	author: one(users, {
		fields: [callNotes.authorUserId],
		references: [users.id],
	}),
}));

export const followUpTasksRelations = relations(followUpTasks, ({ one }) => ({
	call: one(calls, {
		fields: [followUpTasks.callId],
		references: [calls.id],
	}),
	ticket: one(tickets, {
		fields: [followUpTasks.ticketId],
		references: [tickets.id],
	}),
	contact: one(contacts, {
		fields: [followUpTasks.contactId],
		references: [contacts.id],
	}),
	assignee: one(operatorProfiles, {
		fields: [followUpTasks.assignedTo],
		references: [operatorProfiles.id],
	}),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
	contact: one(contacts, {
		fields: [bookings.contactId],
		references: [contacts.id],
	}),
	call: one(calls, {
		fields: [bookings.callId],
		references: [calls.id],
	}),
	ticket: one(tickets, {
		fields: [bookings.ticketId],
		references: [tickets.id],
	}),
	assignee: one(operatorProfiles, {
		fields: [bookings.assignedTo],
		references: [operatorProfiles.id],
	}),
}));

export const sipExtensionsRelations = relations(sipExtensions, ({ one }) => ({
	operatorProfile: one(operatorProfiles, {
		fields: [sipExtensions.operatorProfileId],
		references: [operatorProfiles.id],
	}),
}));
