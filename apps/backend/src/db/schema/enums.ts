import { pgEnum } from "drizzle-orm/pg-core";

export const operatorStatusEnum = pgEnum("operator_status", ["online", "offline", "pause", "busy"]);

export const callDirectionEnum = pgEnum("call_direction", ["inbound", "outbound"]);

export const callStatusEnum = pgEnum("call_status", [
	"ringing",
	"answered",
	"missed",
	"abandoned",
	"completed",
]);

export const ticketStatusEnum = pgEnum("ticket_status", [
	"new",
	"in_progress",
	"resolved",
	"closed",
	"reopened",
]);

export const ticketPriorityEnum = pgEnum("ticket_priority", ["low", "medium", "high"]);

export const aiStatusEnum = pgEnum("ai_status", ["pending", "processing", "completed", "failed"]);

export const sentimentEnum = pgEnum("sentiment", ["positive", "neutral", "negative"]);
