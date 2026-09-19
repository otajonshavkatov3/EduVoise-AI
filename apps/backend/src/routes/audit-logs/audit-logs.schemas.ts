import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";

export const AuditLogItemSchema = z.object({
	id: uuidSchema,
	userId: uuidSchema.nullable(),
	userName: z.string().nullable(),
	action: z.string(),
	entityType: z.string().nullable(),
	entityId: uuidSchema.nullable(),
	details: z.record(z.string(), z.unknown()).nullable(),
	ipAddress: z.string().nullable(),
	userAgent: z.string().nullable(),
	createdAt: z.string().datetime(),
});

export const ListQuerySchema = z
	.object({
		userId: uuidSchema.optional().openapi({ param: { name: "userId", in: "query" } }),
		action: z
			.string()
			.max(100)
			.optional()
			.openapi({ param: { name: "action", in: "query" } }),
		from: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "from", in: "query" } }),
		to: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "to", in: "query" } }),
	})
	.merge(PaginationQuerySchema);

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(AuditLogItemSchema),
		meta: PaginationMetaSchema,
	}),
});

export type AuditLogItem = z.infer<typeof AuditLogItemSchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
