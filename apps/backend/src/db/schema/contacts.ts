import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

import { tenantIdColumn } from "./tenants";

export const contacts = pgTable(
	"contacts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		phoneNumber: varchar("phone_number", { length: 20 }).notNull(),
		firstName: varchar("first_name", { length: 100 }),
		lastName: varchar("last_name", { length: 100 }),
		address: jsonb("address").$type<{
			tuman: string;
			kocha: string;
			uy: string;
		}>(),
		notes: text("notes"),
		isDeleted: boolean("is_deleted").notNull().default(false),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// Per tenant, not global: the same person can be a customer of two call
		// centres, and one tenant importing a number must not collide with - or
		// reveal the existence of - another tenant's contact.
		uniqueIndex("idx_contacts_tenant_phone").on(table.tenantId, table.phoneNumber),
		index("idx_contacts_tenant_created").on(table.tenantId, table.createdAt),
		index("idx_contacts_first_name").on(table.firstName),
		index("idx_contacts_last_name").on(table.lastName),
	]
);
