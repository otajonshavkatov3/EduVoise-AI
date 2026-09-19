import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, phoneSchema } from "@/lib";

export const ticketStatusEnum = z.enum(["new", "in_progress", "resolved", "closed", "reopened"]);
export const ticketPriorityEnum = z.enum(["low", "medium", "high"]);

export const CreateBodySchema = z.object({
	contactId: z.string().uuid(),
	subject: z.string().min(1).max(255),
	description: z.string().min(1),
	category: z.string().max(100).optional(),
	priority: ticketPriorityEnum.optional().default("medium"),
});

export const UpdateBodySchema = z.object({
	subject: z.string().min(1).max(255).optional(),
	description: z.string().min(1).optional(),
	category: z.string().max(100).optional(),
	priority: ticketPriorityEnum.optional(),
	status: ticketStatusEnum.optional(),
});

export const TicketItemSchema = z.object({
	id: z.string().uuid(),
	contactId: z.string().uuid(),
	createdBy: z.string().uuid(),
	subject: z.string(),
	description: z.string(),
	category: z.string().nullable(),
	priority: ticketPriorityEnum,
	status: ticketStatusEnum,
	externalRefId: z.string().nullable(),
	aiSummary: z.string().nullable(),
	isDeleted: z.boolean(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	closedAt: z.string().datetime().nullable(),
	contact: z
		.object({
			id: z.string().uuid(),
			phoneNumber: z.string(),
			firstName: z.string().nullable(),
			lastName: z.string().nullable(),
		})
		.optional(),
	creator: z
		.object({
			id: z.string().uuid(),
			phone: z.string(),
			role: z.string(),
		})
		.optional(),
});

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(TicketItemSchema),
		meta: PaginationMetaSchema,
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: TicketItemSchema,
});

export const RemoveOutSchema = z.object({
	success: z.literal(true),
	data: z.object({ message: z.string() }),
});

export const ListQuerySchema = z
	.object({
		phoneNumber: phoneSchema.optional().openapi({
			param: { name: "phoneNumber", in: "query", description: "Contact raqami bo'yicha filtrlash" },
		}),
		status: ticketStatusEnum.optional(),
		priority: ticketPriorityEnum.optional(),
		/** Mavzu bo'yicha erkin matnli qidiruv. Frontend buni allaqachon yuborardi. */
		q: z
			.string()
			.trim()
			.min(1)
			.max(255)
			.optional()
			.openapi({
				param: { name: "q", in: "query", description: "Mavzu bo'yicha qidirish" },
			}),
		contactId: z.string().uuid().optional(),
		createdBy: z.string().uuid().optional(),
		includeDeleted: z.enum(["true", "false"]).optional().default("false"),
	})
	.merge(PaginationQuerySchema);

export type CreateBody = z.infer<typeof CreateBodySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
export type TicketItem = z.infer<typeof TicketItemSchema>;
