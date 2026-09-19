ALTER TABLE "tickets" ADD COLUMN "external_ref_id" varchar(100);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tickets_external_ref" ON "tickets" USING btree ("external_ref_id");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_external_ref_id_unique" UNIQUE("external_ref_id");