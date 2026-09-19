import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, uuidSchema } from "@/lib";

export const bookingStatusEnum = z.enum(["scheduled", "confirmed", "cancelled", "completed"]);

export const calendarViewEnum = z.enum(["month", "week"]);

/** Kalendar kunlari UTC bo'yicha guruhlanadi (YYYY-MM-DD). */
const dayKeySchema = z.string().openapi({ example: "2026-08-04" });

export const BookingItemSchema = z
	.object({
		id: uuidSchema,
		contactId: uuidSchema,
		callId: uuidSchema.nullable(),
		ticketId: uuidSchema.nullable(),
		assignedTo: uuidSchema.nullable(),
		title: z.string(),
		notes: z.string().nullable(),
		scheduledAt: z.string().datetime(),
		/** scheduledAt + durationMinutes, kalendar uchun hisoblab beriladi. */
		endsAt: z.string().datetime(),
		durationMinutes: z.number().int(),
		location: z.string().nullable(),
		status: bookingStatusEnum,
		createdBySystem: z.boolean(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
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
	.openapi("BookingItem");

export const CreateBodySchema = z
	.object({
		contactId: z.string().uuid(),
		callId: z.string().uuid().optional(),
		ticketId: z.string().uuid().optional(),
		/** operatorProfiles.id (users.id emas). */
		assignedTo: z.string().uuid().optional(),
		title: z.string().min(1).max(255),
		notes: z.string().min(1).optional(),
		scheduledAt: z.string().datetime(),
		durationMinutes: z.number().int().min(1).max(1440).optional().default(30),
		location: z.string().min(1).max(500).optional(),
	})
	.openapi("BookingCreateBody");

export const UpdateBodySchema = z
	.object({
		title: z.string().min(1).max(255).optional(),
		notes: z.string().min(1).nullable().optional(),
		scheduledAt: z.string().datetime().optional(),
		durationMinutes: z.number().int().min(1).max(1440).optional(),
		location: z.string().min(1).max(500).nullable().optional(),
		status: bookingStatusEnum.optional(),
		/** operatorProfiles.id; faqat admin/supervisor o'zgartira oladi. */
		assignedTo: z.string().uuid().nullable().optional(),
	})
	.openapi("BookingUpdateBody");

export const ListQuerySchema = z
	.object({
		status: bookingStatusEnum.optional().openapi({ param: { name: "status", in: "query" } }),
		assignedTo: uuidSchema.optional().openapi({
			param: { name: "assignedTo", in: "query", description: "operatorProfiles.id" },
		}),
		contactId: uuidSchema.optional().openapi({ param: { name: "contactId", in: "query" } }),
		callId: uuidSchema.optional().openapi({ param: { name: "callId", in: "query" } }),
		ticketId: uuidSchema.optional().openapi({ param: { name: "ticketId", in: "query" } }),
		from: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "from", in: "query", description: "scheduledAt >= (ISO)" } }),
		to: z
			.string()
			.datetime()
			.optional()
			.openapi({ param: { name: "to", in: "query", description: "scheduledAt <= (ISO)" } }),
	})
	.merge(PaginationQuerySchema);

export const CalendarQuerySchema = z.object({
	view: calendarViewEnum
		.optional()
		.default("month")
		.openapi({
			param: { name: "view", in: "query", description: "month (default) yoki week" },
		}),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD formatida bo'lishi kerak")
		.optional()
		.openapi({
			param: {
				name: "date",
				in: "query",
				description: "Tayanch kun (default: bugun). Oy/hafta shu kundan hisoblanadi, UTC.",
			},
			example: "2026-08-04",
		}),
	status: bookingStatusEnum.optional().openapi({ param: { name: "status", in: "query" } }),
	assignedTo: uuidSchema.optional().openapi({
		param: { name: "assignedTo", in: "query", description: "operatorProfiles.id" },
	}),
});

export const CalendarDaySchema = z
	.object({
		date: dayKeySchema,
		count: z.number().int(),
		items: z.array(BookingItemSchema),
	})
	.openapi("BookingCalendarDay");

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(BookingItemSchema),
		meta: PaginationMetaSchema,
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: BookingItemSchema,
});

export const CalendarOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		view: calendarViewEnum,
		range: z.object({
			from: z.string().datetime(),
			to: z.string().datetime(),
		}),
		total: z.number().int(),
		days: z.array(CalendarDaySchema),
	}),
});

export const CancelOutSchema = z.object({
	success: z.literal(true),
	data: z.object({ message: z.string() }),
});

export type BookingItem = z.infer<typeof BookingItemSchema>;
export type CreateBody = z.infer<typeof CreateBodySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type CalendarQuery = z.infer<typeof CalendarQuerySchema>;
