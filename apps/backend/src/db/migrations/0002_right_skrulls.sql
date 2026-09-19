ALTER TABLE "calls" DROP CONSTRAINT "calls_operator_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_operator_id_operator_profiles_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator_profiles"("id") ON DELETE set null ON UPDATE no action;