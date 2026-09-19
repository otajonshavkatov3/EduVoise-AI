import { z } from "@hono/zod-openapi";

import { PaginationMetaSchema, PaginationQuerySchema, phoneSchema } from "@/lib";

export const AddressSchema = z.object({
	tuman: z.string().min(1),
	kocha: z.string().min(1),
	uy: z.string().min(1),
});

export const CreateBodySchema = z.object({
	phoneNumber: phoneSchema,
	firstName: z.string().max(100).optional(),
	lastName: z.string().max(100).optional(),
	address: AddressSchema.optional(),
	notes: z.string().optional(),
});

export const UpdateBodySchema = z.object({
	phoneNumber: phoneSchema.optional(),
	firstName: z.string().max(100).optional(),
	lastName: z.string().max(100).optional(),
	address: AddressSchema.nullable().optional(),
	notes: z.string().nullable().optional(),
});

export const ContactItemSchema = z.object({
	id: z.string().uuid(),
	phoneNumber: z.string(),
	firstName: z.string().nullable(),
	lastName: z.string().nullable(),
	address: AddressSchema.nullable(),
	notes: z.string().nullable(),
	isDeleted: z.boolean(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

export const ListOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(ContactItemSchema),
		meta: PaginationMetaSchema,
	}),
});

export const OneOutSchema = z.object({
	success: z.literal(true),
	data: ContactItemSchema.extend({
		/** Shu raqam bo'yicha jami qo'ng'iroqlar soni (tarix calls endpointida phoneNumber bo'yicha) */
		callsCount: z.number().int(),
		/** Shu contact bo'yicha ticketlar soni */
		ticketsCount: z.number().int(),
	}),
});

export const LookupQuerySchema = z.object({
	phoneNumber: phoneSchema.openapi({
		param: { name: "phoneNumber", in: "query" },
		example: "+998901234567",
	}),
});

export const LookupOutSchema = z.object({
	success: z.literal(true),
	data: z.object({
		contact: ContactItemSchema.nullable(),
	}),
});

export const RemoveOutSchema = z.object({
	success: z.literal(true),
	data: z.object({ message: z.string() }),
});

export const ListQuerySchema = z
	.object({
		phoneNumber: z.string().optional(),
		q: z.string().optional(),
		includeDeleted: z.enum(["true", "false"]).optional().default("false"),
	})
	.merge(PaginationQuerySchema);

export type CreateBody = z.infer<typeof CreateBodySchema>;
export type UpdateBody = z.infer<typeof UpdateBodySchema>;
export type ContactItem = z.infer<typeof ContactItemSchema>;
