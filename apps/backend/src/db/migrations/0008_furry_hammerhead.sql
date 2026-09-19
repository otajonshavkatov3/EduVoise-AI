ALTER TABLE "tickets" DROP CONSTRAINT "tickets_mnazorat_ref_id_unique";--> statement-breakpoint
DROP INDEX "idx_tickets_mnazorat";--> statement-breakpoint
ALTER TABLE "tickets" DROP COLUMN "mnazorat_ref_id";