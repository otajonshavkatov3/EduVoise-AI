CREATE TYPE "public"."campaign_kind" AS ENUM('reminder', 'sales', 'promo', 'survey', 'other');--> statement-breakpoint
CREATE TYPE "public"."campaign_lead_status" AS ENUM('pending', 'calling', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."campaign_outcome" AS ENUM('answered', 'no_answer', 'busy', 'invalid_number', 'refused', 'agreed', 'callback_requested', 'wrong_person', 'do_not_call', 'failed');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'running', 'paused', 'finished', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."dnc_source" AS ENUM('asked_on_call', 'manual', 'import');--> statement-breakpoint
CREATE TABLE "call_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"kind" "campaign_kind" DEFAULT 'other' NOT NULL,
	"purpose" text NOT NULL,
	"script" text,
	"agent_profile_id" uuid,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"call_window_start" varchar(5) DEFAULT '09:00' NOT NULL,
	"call_window_end" varchar(5) DEFAULT '18:00' NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"retry_delay_minutes" integer DEFAULT 60 NOT NULL,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"started_by" uuid,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_campaigns_window_format_chk" CHECK ("call_campaigns"."call_window_start" ~ '^[0-2][0-9]:[0-5][0-9]$' AND "call_campaigns"."call_window_end" ~ '^[0-2][0-9]:[0-5][0-9]$'),
	CONSTRAINT "call_campaigns_window_order_chk" CHECK ("call_campaigns"."call_window_start" < "call_campaigns"."call_window_end"),
	CONSTRAINT "call_campaigns_window_bounds_chk" CHECK ("call_campaigns"."call_window_start" >= '07:00' AND "call_campaigns"."call_window_end" <= '22:00'),
	CONSTRAINT "call_campaigns_limits_chk" CHECK ("call_campaigns"."max_attempts" BETWEEN 1 AND 10 AND "call_campaigns"."retry_delay_minutes" BETWEEN 5 AND 1440 AND "call_campaigns"."concurrency" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "campaign_call_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"call_id" uuid,
	"outcome" "campaign_outcome",
	"detail" text,
	"dialed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaign_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"full_name" varchar(150),
	"contact_id" uuid,
	"variables" jsonb,
	"status" "campaign_lead_status" DEFAULT 'pending' NOT NULL,
	"outcome" "campaign_outcome",
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"call_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_leads_attempts_chk" CHECK ("campaign_leads"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "do_not_call_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"reason" text,
	"source" "dnc_source" DEFAULT 'manual' NOT NULL,
	"call_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_campaigns" ADD CONSTRAINT "call_campaigns_agent_profile_id_ai_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."ai_agent_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_campaigns" ADD CONSTRAINT "call_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_campaigns" ADD CONSTRAINT "call_campaigns_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_campaigns" ADD CONSTRAINT "call_campaigns_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_call_attempts" ADD CONSTRAINT "campaign_call_attempts_campaign_id_call_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."call_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_call_attempts" ADD CONSTRAINT "campaign_call_attempts_lead_id_campaign_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."campaign_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_call_attempts" ADD CONSTRAINT "campaign_call_attempts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_campaign_id_call_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."call_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "do_not_call_list" ADD CONSTRAINT "do_not_call_list_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "do_not_call_list" ADD CONSTRAINT "do_not_call_list_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_campaigns_status" ON "call_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_campaigns_created_at" ON "call_campaigns" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_campaigns_created_by" ON "call_campaigns" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_campaigns_profile" ON "call_campaigns" USING btree ("agent_profile_id");--> statement-breakpoint
CREATE INDEX "idx_campaign_attempts_lead" ON "campaign_call_attempts" USING btree ("lead_id","attempt_no");--> statement-breakpoint
CREATE INDEX "idx_campaign_attempts_campaign" ON "campaign_call_attempts" USING btree ("campaign_id","dialed_at");--> statement-breakpoint
CREATE INDEX "idx_campaign_attempts_call" ON "campaign_call_attempts" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_campaign_leads_campaign_phone" ON "campaign_leads" USING btree ("campaign_id","phone_number");--> statement-breakpoint
CREATE INDEX "idx_campaign_leads_due" ON "campaign_leads" USING btree ("campaign_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_campaign_leads_outcome" ON "campaign_leads" USING btree ("campaign_id","outcome");--> statement-breakpoint
CREATE INDEX "idx_campaign_leads_phone" ON "campaign_leads" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "idx_campaign_leads_call" ON "campaign_leads" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "idx_campaign_leads_contact" ON "campaign_leads" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_dnc_phone" ON "do_not_call_list" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "idx_dnc_source" ON "do_not_call_list" USING btree ("source");--> statement-breakpoint
CREATE INDEX "idx_dnc_created_at" ON "do_not_call_list" USING btree ("created_at");