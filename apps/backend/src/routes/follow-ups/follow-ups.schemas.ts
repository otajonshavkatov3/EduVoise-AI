import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";

export const followUpStatusEnum = z.enum(["open", "in_progress", "done", "cancelled"]);

/** Query paramlar string bo'lib keladi, shuning uchun boolean flaglar "true"/"false". */
const boolQueryEnum = z.enum(["true", "false"]);

export const FollowUpItemSchema = z
	.object({
		id: uuidSchema,
		callId: uuidSchema.nullable(),
		ticketId: uuidSchema.nullable(),
		contactId: uuidSchema.nullable(),
		assignedTo: uuidSchema.nullable(),
		title: z.string(),
		description: z.string().nullable(),
		dueAt: z.string().datetime().nullable(),
		status: followUpStatusEnum,
		createdBySystem: z.boolean(),
		/** dueAt o'tgan va vazifa hali yopilmagan bo'lsa true. */
		isOverdue: z.boolean(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		completedAt: z.string().datetime().nullable(),
		contact: z
			.object({
				id: uuidSchema,
				phoneNumber: z.string(),
				firstName: z.string().nullable(),
				lastName: z.string().nullable(),
			})
			.nullable(),
		assignee: z
			.object({
				id: uuidSchema,
				userId: uuidSchema,
				extension: z.string(),
			})
			.nullable(),
	})
	.openapi("FollowUpTaskItem");

export const CreateBodySchema = z
	.object({
		title: z.string().min(1).max(255),
		description: z.string().min(1).optional(),
		dueAt: z.string().datetime().optional(),
		callId: z.string().uuid().optional(),
		ticketId: z.string().uuid().optional(),
		contactId: z.string().uuid().optional(),
		/** operatorProfiles.id (users.id emas). */
		assignedTo: z.string().uuid().optional(),
	})
	.openapi("FollowUpCreateBody");

export const UpdateBodySchema = z
	.object({
		title: z.string().min(1).max(255).optional(),
		description: z.string().min(1).nullable().optional(),
		dueAt: z.string().datetime().nullable().optional(),
		status: followUpStatusEnum.optional(),
		/** operatorProfiles.id; faqat admin/supervisor o'zgartira oladi. */
		assignedTo: z.string().uuid().nullable().optional(),
	})
	.openapi("FollowUpUpdateBody");

export const ListQuerySchema = z
	.object({
		status: followUpStatusEnum.optional().openapi({ param: { name: "status", in: "query" } }),
		assignedTo: uuidSchema.optional().openapi({
			param: { name: "assignedTo", in: "query", description: "operatorProfiles.id" },
		}),
		contactId: uuidSchema.optional().openapi({ param: { name: "contactId", in: "query" } }),
		callId: uuidSchema.optional().openapi({ param: { name: "callId", in: "query" } }),
		ticketId: uuidSchema.optional().openapi({ param: { name: "ticketId", in: "query" } }),
		dueFrom: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "dueFrom", in: "query", description: "dueAt >= (ISO)" } }),
		dueTo: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "dueTo", in: "query", description: "dueAt <= (ISO)" } }),
		overdue: boolQueryEnum
			.optional()
			.default("false")
			.openapi({
				param: {
					name: "overdue",
					in: "query",
					description: "true — muddati o'tgan va yopilmagan vazifalar",
				},
			}),
		createdBySystem: boolQueryEnum.optional().openapi({
			param: {
				name: "createdBySystem",
				in: "query",
				description: "true — AI yaratgan, false — qo'lda yaratilgan",
			},
		}),
	})
	.merge(PaginationQuerySchema);

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(FollowUpItemSchema),
		meta: PaginationMetaSchema,
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: FollowUpItemSchema,
});

export const CancelOutSchema = z.object({
	success: z.literal(true),
	data: z.object({ message: z.string() }),
});

export type FollowUpItem = z.infer<typeof FollowUpItemSchema>;
export type CreateBody = z.infer<typeof CreateBodySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
