ALTER TABLE "ai_sessions" ADD COLUMN "cached_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "input_text_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "input_audio_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "output_text_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "output_audio_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "response_turns" integer;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "transcribe_audio_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "transcribe_text_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "transcribe_model" varchar(100);--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD COLUMN "analysis_model" varchar(100);--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD COLUMN "prompt_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD COLUMN "cached_prompt_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD COLUMN "completion_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD COLUMN "billed_runs" integer DEFAULT 0 NOT NULL;