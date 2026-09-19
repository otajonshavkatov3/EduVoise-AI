CREATE TYPE "public"."ai_session_status" AS ENUM('initializing', 'active', 'transferring', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('scheduled', 'confirmed', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."follow_up_status" AS ENUM('open', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."note_author_type" AS ENUM('ai', 'operator', 'system');--> statement-breakpoint
CREATE TYPE "public"."sip_extension_kind" AS ENUM('sip', 'webrtc', 'ai');--> statement-breakpoint
CREATE TYPE "public"."transcript_role" AS ENUM('caller', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('requested', 'ringing', 'connected', 'failed', 'abandoned');--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"channel_id" varchar(150),
	"provider" varchar(50) DEFAULT 'openai-realtime' NOT NULL,
	"model" varchar(100),
	"voice" varchar(50),
	"language" varchar(10) DEFAULT 'uz',
	"status" "ai_session_status" DEFAULT 'initializing' NOT NULL,
	"interruptions" integer DEFAULT 0 NOT NULL,
	"input_audio_ms" integer DEFAULT 0 NOT NULL,
	"output_audio_ms" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"error_message" text,
	"metadata" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"call_id" uuid,
	"ticket_id" uuid,
	"assigned_to" uuid,
	"title" varchar(255) NOT NULL,
	"notes" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"location" text,
	"status" "booking_status" DEFAULT 'scheduled' NOT NULL,
	"created_by_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid,
	"ticket_id" uuid,
	"author_type" "note_author_type" DEFAULT 'ai' NOT NULL,
	"author_user_id" uuid,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"format" varchar(10) DEFAULT 'wav' NOT NULL,
	"size_bytes" integer,
	"duration_seconds" integer,
	"is_available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"ai_session_id" uuid,
	"role" "transcript_role" NOT NULL,
	"content" text NOT NULL,
	"start_ms" integer,
	"end_ms" integer,
	"is_final" boolean DEFAULT true NOT NULL,
	"confidence" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"ai_session_id" uuid,
	"from_channel_id" varchar(150),
	"to_channel_id" varchar(150),
	"to_extension" varchar(10) NOT NULL,
	"to_operator_id" uuid,
	"reason" text,
	"status" "transfer_status" DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_up_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid,
	"ticket_id" uuid,
	"contact_id" uuid,
	"assigned_to" uuid,
	"title" varchar(255) NOT NULL,
	"description" text,
	"due_at" timestamp with time zone,
	"status" "follow_up_status" DEFAULT 'open' NOT NULL,
	"created_by_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sip_extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extension" varchar(10) NOT NULL,
	"display_name" varchar(100),
	"operator_profile_id" uuid,
	"kind" "sip_extension_kind" DEFAULT 'sip' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_registered_at" timestamp with time zone,
	"last_known_status" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_assigned_to_operator_profiles_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."operator_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_notes" ADD CONSTRAINT "call_notes_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_notes" ADD CONSTRAINT "call_notes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_notes" ADD CONSTRAINT "call_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_ai_session_id_ai_sessions_id_fk" FOREIGN KEY ("ai_session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transfers" ADD CONSTRAINT "call_transfers_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transfers" ADD CONSTRAINT "call_transfers_ai_session_id_ai_sessions_id_fk" FOREIGN KEY ("ai_session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transfers" ADD CONSTRAINT "call_transfers_to_operator_id_operator_profiles_id_fk" FOREIGN KEY ("to_operator_id") REFERENCES "public"."operator_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_assigned_to_operator_profiles_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."operator_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sip_extensions" ADD CONSTRAINT "sip_extensions_operator_profile_id_operator_profiles_id_fk" FOREIGN KEY ("operator_profile_id") REFERENCES "public"."operator_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ai_sessions_call" ON "ai_sessions" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "idx_ai_sessions_channel" ON "ai_sessions" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_ai_sessions_status" ON "ai_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ai_sessions_started_at" ON "ai_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_bookings_scheduled_at" ON "bookings" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_bookings_contact" ON "bookings" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_bookings_status" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_bookings_assigned" ON "bookings" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "idx_call_notes_call" ON "call_notes" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "idx_call_notes_ticket" ON "call_notes" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_call_notes_author_type" ON "call_notes" USING btree ("author_type");--> statement-breakpoint
CREATE INDEX "idx_recordings_call" ON "call_recordings" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "idx_recordings_available" ON "call_recordings" USING btree ("is_available");--> statement-breakpoint
CREATE INDEX "idx_recordings_created_at" ON "call_recordings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_transcripts_call" ON "call_transcripts" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "idx_transcripts_call_start" ON "call_transcripts" USING btree ("call_id","start_ms");--> statement-breakpoint
CREATE INDEX "idx_transcripts_session" ON "call_transcripts" USING btree ("ai_session_id");--> statement-breakpoint
CREATE INDEX "idx_transcripts_role" ON "call_transcripts" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_transfers_call" ON "call_transfers" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "idx_transfers_operator" ON "call_transfers" USING btree ("to_operator_id");--> statement-breakpoint
CREATE INDEX "idx_transfers_status" ON "call_transfers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_followups_status" ON "follow_up_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_followups_due_at" ON "follow_up_tasks" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "idx_followups_assigned" ON "follow_up_tasks" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "idx_followups_contact" ON "follow_up_tasks" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_followups_call" ON "follow_up_tasks" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sip_extensions_ext" ON "sip_extensions" USING btree ("extension");--> statement-breakpoint
CREATE INDEX "idx_sip_extensions_operator" ON "sip_extensions" USING btree ("operator_profile_id");