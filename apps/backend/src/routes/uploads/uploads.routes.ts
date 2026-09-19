import { createRoute, HttpStatusCodes, jsonContent } from "@/lib";
import {
	CallRecordingFileParamSchema,
	CallRecordingTenantFileParamSchema,
	UploadErrorSchema,
	UploadResponseSchema,
} from "./uploads.schemas";

export const uploadRecording = createRoute({
	method: "post",
	path: "/recording",
	tags: ["Uploads"],
	summary: "Upload call recording file",
	description: "Accepts a single audio file and returns a public path to it.",
	request: {
		body: {
			content: {
				"multipart/form-data": {
					schema: undefined as never, // documented as generic multipart
				},
			},
			required: true,
		},
	},
	// Handler doim 201 qaytaradi (`created()`), lekin bu yerda 200 e'lon
	// qilingan edi — ya'ni OpenAPI hujjati amaldagi javob bilan mos emasdi.
	// Javob TANASI o'zgarmaydi, faqat kod va xato javobi to'g'ri e'lon qilinadi.
	responses: {
		[HttpStatusCodes.CREATED]: jsonContent(UploadResponseSchema, "Upload successful"),
		[HttpStatusCodes.BAD_REQUEST]: jsonContent(
			UploadErrorSchema,
			"Yaroqsiz content-type yoki `file` maydoni yo'q"
		),
	},
});

export const getCallRecording = createRoute({
	method: "get",
	path: "/call-recordings/{fileName}",
	tags: ["Uploads"],
	summary: "Get call recording file",
	description:
		"Serves a recording that predates per-tenant directories, plus browser uploads. " +
		"New recordings are served by the two-segment route below.",
	request: { params: CallRecordingFileParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			description: "Audio file stream",
		},
		[HttpStatusCodes.NOT_FOUND]: {
			description: "File not found",
		},
	},
});

/**
 * The same file, in its tenant's own directory.
 *
 * A SEPARATE route rather than a wildcard: a wildcard path would hand this handler
 * an arbitrary string to turn into a file path, and this route is deliberately
 * unauthenticated (an `<audio>` element cannot send a header), so the URL shape is
 * the first line of defence. Two named segments, each validated by a schema that
 * only accepts what the platform itself generates, is a boundary that can be read
 * and checked - `..` never gets as far as the handler.
 */
export const getTenantCallRecording = createRoute({
	method: "get",
	path: "/call-recordings/{tenantSlug}/{fileName}",
	tags: ["Uploads"],
	summary: "Get a call recording from its tenant's directory",
	description: "Serves a call recording written into the tenant's own directory.",
	request: { params: CallRecordingTenantFileParamSchema },
	responses: {
		[HttpStatusCodes.OK]: {
			description: "Audio file stream",
		},
		[HttpStatusCodes.NOT_FOUND]: {
			description: "File not found",
		},
	},
});
