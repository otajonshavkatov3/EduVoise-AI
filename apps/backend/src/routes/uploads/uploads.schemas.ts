import { z } from "@hono/zod-openapi";

export const UploadResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			path: z.string().min(1),
		}),
	})
	.openapi("UploadResponse");

export type UploadResponse = z.infer<typeof UploadResponseSchema>;

/**
 * `uploadRecordingHandler` yaroqsiz so'rovda `{ success: false, error: { message } }`
 * qaytaradi. Bu shakl allaqachon ishlab turgani uchun o'zgartirilmaydi — faqat
 * route'da e'lon qilinadi (avval e'lon qilinmagani uchun TypeScript handlerni
 * qabul qilmasdi).
 */
export const UploadErrorSchema = z
	.object({
		success: z.literal(false),
		error: z.object({
			message: z.string(),
		}),
	})
	.openapi("UploadError");

export const CallRecordingFileParamSchema = z.object({
	fileName: z
		.string()
		.min(1)
		.regex(/^[a-zA-Z0-9._-]+$/, "Invalid fileName")
		.openapi({
			param: { name: "fileName", in: "path", required: true },
			example: "b789a673-03d9-4836-9f4b-e0fc3991ba24.webm",
		}),
});

/**
 * The per-tenant recording path: `/uploads/call-recordings/<slug>/<file>`.
 *
 * The slug pattern is deliberately the SAME one the tenants table enforces
 * (tenants_slug_format_chk), not a looser "safe path segment" rule: this parameter
 * names a directory on disk, so anything it accepts that a real tenant slug cannot
 * be is a path the serving route has to defend against for no benefit. `.` and `..`
 * both fail it, as does any name containing a slash or a backslash.
 */
export const CallRecordingTenantFileParamSchema = z.object({
	tenantSlug: z
		.string()
		.min(2)
		.max(40)
		.regex(/^[a-z][a-z0-9-]{1,39}$/, "Invalid tenantSlug")
		.openapi({
			param: { name: "tenantSlug", in: "path", required: true },
			example: "avilab",
		}),
	fileName: z
		.string()
		.min(1)
		.regex(/^[a-zA-Z0-9._-]+$/, "Invalid fileName")
		.openapi({
			param: { name: "fileName", in: "path", required: true },
			example: "b789a673-03d9-4836-9f4b-e0fc3991ba24.wav",
		}),
});
