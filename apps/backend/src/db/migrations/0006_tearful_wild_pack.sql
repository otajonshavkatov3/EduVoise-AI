CREATE TABLE "ai_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_name" varchar(150) NOT NULL,
	"industry" varchar(100),
	"business_description" text,
	"language" varchar(10) DEFAULT 'uz' NOT NULL,
	"additional_languages" jsonb,
	"voice" varchar(50) DEFAULT 'alloy' NOT NULL,
	"greeting" text,
	"recording_notice" text,
	"custom_instructions" text,
	"ticket_categories" jsonb,
	"unknown_policy" varchar(20) DEFAULT 'transfer' NOT NULL,
	"transfer_extensions" jsonb,
	"business_hours" jsonb,
	"after_hours_message" text,
	"max_call_seconds" integer DEFAULT 900 NOT NULL,
	"silence_hangup_ms" integer DEFAULT 20000 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_base_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_profile_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"tags" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_agent_profiles" ADD CONSTRAINT "ai_agent_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_entries" ADD CONSTRAINT "knowledge_base_entries_agent_profile_id_ai_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."ai_agent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_entries" ADD CONSTRAINT "knowledge_base_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ai_agent_profiles_active" ON "ai_agent_profiles" USING btree ("is_active") WHERE "ai_agent_profiles"."is_active" IS TRUE;--> statement-breakpoint
CREATE INDEX "idx_ai_agent_profiles_name" ON "ai_agent_profiles" USING btree ("business_name");--> statement-breakpoint
CREATE INDEX "idx_kb_profile" ON "knowledge_base_entries" USING btree ("agent_profile_id");--> statement-breakpoint
CREATE INDEX "idx_kb_active" ON "knowledge_base_entries" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_kb_priority" ON "knowledge_base_entries" USING btree ("priority");