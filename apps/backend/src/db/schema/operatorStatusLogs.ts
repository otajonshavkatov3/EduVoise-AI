import { index, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { operatorStatusEnum } from "./enums";
import { operatorProfiles } from "./operatorProfiles";
import { tenantIdColumn } from "./tenants";

export const operatorStatusLogs = pgTable(
	"operator_status_logs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		operatorId: uuid("operator_id")
			.notNull()
			.references(() => operatorProfiles.id, { onDelete: "cascade" }),
		status: operatorStatusEnum("status").notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		duration: integer("duration"),
	},
	(table) => [
		index("idx_status_logs_tenant_started").on(table.tenantId, table.startedAt),
		index("idx_status_logs_operator").on(table.operatorId),
		index("idx_status_logs_started").on(table.startedAt),
		index("idx_status_logs_status").on(table.status),
	]
);
