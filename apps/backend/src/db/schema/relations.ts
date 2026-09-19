import { relations } from "drizzle-orm";
import { auditLogs } from "./auditLogs";
import { aiAnalyses, calls, tickets } from "./callTicketAi";
import { contacts } from "./contacts";
import { operatorProfiles } from "./operatorProfiles";
import { operatorStatusLogs } from "./operatorStatusLogs";
import { refreshTokens } from "./refreshTokens";
import { userSessions } from "./userSessions";
import { users } from "./users";

export const usersRelations = relations(users, ({ one, many }) => ({
	profile: one(operatorProfiles, {
		fields: [users.id],
		references: [operatorProfiles.userId],
	}),
	// calls.operatorId points to operator_profiles.id, so calls are linked via operator_profiles (not directly to users)
	ticketsCreated: many(tickets, { relationName: "creator_tickets" }),
	auditLogs: many(auditLogs),
	refreshTokens: many(refreshTokens),
	sessions: many(userSessions),
}));

// 2. OPERATOR PROFILES RELATIONS
export const operatorProfilesRelations = relations(operatorProfiles, ({ one, many }) => ({
	user: one(users, {
		fields: [operatorProfiles.userId],
		references: [users.id],
	}),
	statusLogs: many(operatorStatusLogs),
}));

// 3. CONTACTS RELATIONS
export const contactsRelations = relations(contacts, ({ many }) => ({
	calls: many(calls),
	tickets: many(tickets),
}));

// 4. CALLS RELATIONS
export const callsRelations = relations(calls, ({ one }) => ({
	contact: one(contacts, {
		fields: [calls.contactId],
		references: [contacts.id],
	}),
	operatorProfile: one(operatorProfiles, {
		fields: [calls.operatorId],
		references: [operatorProfiles.id],
	}),
	ticket: one(tickets, {
		fields: [calls.ticketId],
		references: [tickets.id],
	}),
	aiAnalysis: one(aiAnalyses, {
		fields: [calls.id],
		references: [aiAnalyses.callId],
	}),
}));

// 5. TICKETS RELATIONS
export const ticketsRelations = relations(tickets, ({ one, many }) => ({
	contact: one(contacts, {
		fields: [tickets.contactId],
		references: [contacts.id],
	}),
	creator: one(users, {
		fields: [tickets.createdBy],
		references: [users.id],
		relationName: "creator_tickets",
	}),
	calls: many(calls, { relationName: "ticket_calls" }),
	aiAnalysis: one(aiAnalyses, {
		fields: [tickets.aiAnalysisId],
		references: [aiAnalyses.id],
	}),
}));

// 6. AI ANALYSES RELATIONS
export const aiAnalysesRelations = relations(aiAnalyses, ({ one }) => ({
	call: one(calls, {
		fields: [aiAnalyses.callId],
		references: [calls.id],
	}),
}));

// 7. OPERATOR STATUS LOGS RELATIONS
export const operatorStatusLogsRelations = relations(operatorStatusLogs, ({ one }) => ({
	operator: one(operatorProfiles, {
		fields: [operatorStatusLogs.operatorId],
		references: [operatorProfiles.id],
	}),
}));

// 8. AUDIT LOGS RELATIONS
export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
	user: one(users, {
		fields: [auditLogs.userId],
		references: [users.id],
	}),
}));

// 9. REFRESH TOKENS RELATIONS
export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
	user: one(users, {
		fields: [refreshTokens.userId],
		references: [users.id],
	}),
}));

// 10. USER SESSIONS RELATIONS
export const userSessionsRelations = relations(userSessions, ({ one }) => ({
	user: one(users, {
		fields: [userSessions.userId],
		references: [users.id],
	}),
}));
