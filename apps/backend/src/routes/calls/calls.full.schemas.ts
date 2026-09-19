/**
 * The contract for GET /calls/{id}/full - everything about one call in one
 * response.
 *
 * Kept out of calls.schemas.ts because it is a different kind of object: that
 * file describes a row of the call table, this one describes a page. Mixing them
 * would make the list schemas hard to find inside 300 lines of nested detail.
 *
 * Two rules run through the whole file:
 *
 *   - ids that a human reads are resolved to names here, not in the browser. The
 *     old detail page rendered a raw uuid under the "Operator" label because the
 *     name lived in a table the query did not join.
 *   - a number that is not known is null, never 0. "ma'lumot yo'q" and "0 so'm"
 *     are different sentences, and only one of them is true.
 */
import { z } from "@hono/zod-openapi";

import { uuidSchema } from "@/lib";

import { CallOneSchema } from "./calls.schemas";

const transcriptRoleEnum = z.enum(["caller", "agent", "system"]);
const sentimentEnum = z.enum(["positive", "neutral", "negative"]);
const aiStatusEnum = z.enum(["pending", "processing", "completed", "failed"]);
const aiSessionStatusEnum = z.enum([
	"initializing",
	"active",
	"transferring",
	"completed",
	"failed",
]);
const transferStatusEnum = z.enum(["requested", "ringing", "connected", "failed", "abandoned"]);
const followUpStatusEnum = z.enum(["open", "in_progress", "done", "cancelled"]);
const bookingStatusEnum = z.enum(["scheduled", "confirmed", "cancelled", "completed"]);
const noteAuthorTypeEnum = z.enum(["ai", "operator", "system"]);
const ticketStatusEnum = z.enum(["new", "in_progress", "resolved", "closed", "reopened"]);
const ticketPriorityEnum = z.enum(["low", "medium", "high"]);

/** An operator, named. `name` is the username, falling back to the phone number. */
export const NamedOperatorSchema = z
	.object({
		id: uuidSchema,
		name: z.string(),
		extension: z.string().nullable(),
	})
	.openapi("CallFullOperator");

/** A user, named. Same fallback rule as NamedOperatorSchema. */
export const NamedUserSchema = z
	.object({
		id: uuidSchema,
		name: z.string(),
	})
	.openapi("CallFullUser");

// ===========================================
// The call itself
// ===========================================

/**
 * The same object GET /calls/{id} returns, plus what only the detail page needs.
 *
 * Deliberately a superset rather than a new shape: the frontend already has a
 * type for this and reusing it is what makes the merged page a consolidation
 * instead of a rewrite.
 */
export const CallFullCallSchema = CallOneSchema.extend({
	/** Ko'tarilgan vaqt. Null — qo'ng'iroq umuman javobsiz qolgan. */
	answeredAt: z.string().datetime().nullable(),
	/** Javob berishgacha kutilgan soniya. Null — javob berilmagan. */
	waitSeconds: z.number().int().nullable(),
	/** Operator ismi (username, bo'lmasa telefon raqami). */
	operatorName: z.string().nullable(),
}).openapi("CallFullCall");

// ===========================================
// Recording
// ===========================================

export const CallFullRecordingSchema = z
	.object({
		/**
		 * null — yozuv faqat `calls.recording_path` da mavjud (eski softphone yo'li),
		 * `call_recordings` jadvalida qatori yo'q.
		 */
		id: uuidSchema.nullable(),
		fileName: z.string(),
		/**
		 * API ildiziga nisbatan yo'l, masalan `/uploads/call-recordings/<fayl>.wav`.
		 * Frontend uni `${VITE_API_URL}/api` bilan qo'shadi. Bu route ataylab
		 * autentifikatsiyasiz: `<audio src>` va `<a download>` Authorization
		 * sarlavhasini yubora olmaydi.
		 */
		url: z.string(),
		format: z.string(),
		sizeBytes: z.number().int().nullable(),
		durationSeconds: z.number().int().nullable(),
		/** false — qator bor, fayl yo'q. Yozuv bo'lganini ko'rsatib turadi. */
		isAvailable: z.boolean(),
		createdAt: z.string().datetime().nullable(),
	})
	.openapi("CallFullRecording");

// ===========================================
// Transcript
// ===========================================

export const CallFullTranscriptLineSchema = z
	.object({
		id: uuidSchema,
		callId: uuidSchema,
		aiSessionId: uuidSchema.nullable(),
		role: transcriptRoleEnum,
		content: z.string(),
		startMs: z.number().int().nullable(),
		endMs: z.number().int().nullable(),
		isFinal: z.boolean(),
		confidence: z.number().int().nullable(),
		createdAt: z.string().datetime(),
	})
	.openapi("CallFullTranscriptLine");

export const CallFullTranscriptsSchema = z
	.object({
		/** Aytilish tartibida: startMs, so'ng createdAt. */
		items: z.array(CallFullTranscriptLineSchema),
		/** Qatorlarning umumiy soni (chegaradan qat'i nazar). */
		total: z.number().int(),
		/** true — server chegarasi tufayli hammasi qaytmadi. */
		truncated: z.boolean(),
		/** Oraliq (isFinal=false) qatorlar ham qaytarilganmi. */
		includesInterim: z.boolean(),
	})
	.openapi("CallFullTranscripts");

// ===========================================
// AI analysis
// ===========================================

export const CallFullAnalysisSchema = z
	.object({
		/** PATCH /ai-analyses/{id} va POST /ai-analyses/{id}/retry shu id bilan ishlaydi. */
		id: uuidSchema,
		status: aiStatusEnum,
		summary: z.string().nullable(),
		sentiment: sentimentEnum.nullable(),
		categories: z.array(z.string()).nullable(),
		confidence: z.number().int().nullable(),
		errorMessage: z.string().nullable(),
		retryCount: z.number().int(),
		/**
		 * Tahlil qilingan matn saqlanganmi. Retry shu asosda mumkin yoki mumkin emas,
		 * shuning uchun matnning o'zi emas, borligi qaytadi — transkript qatorlari
		 * javobda alohida bor, ikkinchi nusxasi payloadni ikki baravar qilardi.
		 */
		hasTranscript: z.boolean(),
		transcriptChars: z.number().int(),
		processedAt: z.string().datetime().nullable(),
		createdAt: z.string().datetime(),
	})
	.openapi("CallFullAnalysis");

// ===========================================
// AI session
// ===========================================

export const CallFullSessionTokensSchema = z
	.object({
		promptTokens: z.number().int().nullable(),
		cachedPromptTokens: z.number().int().nullable(),
		inputTextTokens: z.number().int().nullable(),
		inputAudioTokens: z.number().int().nullable(),
		completionTokens: z.number().int().nullable(),
		outputTextTokens: z.number().int().nullable(),
		outputAudioTokens: z.number().int().nullable(),
		transcribeAudioTokens: z.number().int().nullable(),
		transcribeTextTokens: z.number().int().nullable(),
		transcribeModel: z.string().nullable(),
	})
	.openapi("CallFullSessionTokens");

export const CallFullSessionSchema = z
	.object({
		id: uuidSchema,
		channelId: z.string().nullable(),
		provider: z.string(),
		model: z.string().nullable(),
		voice: z.string().nullable(),
		language: z.string().nullable(),
		status: aiSessionStatusEnum,
		/** Agent gapirayotganda qo'ng'iroq qiluvchi uni bo'lgan holatlar soni. */
		interruptions: z.number().int(),
		inputAudioMs: z.number().int(),
		outputAudioMs: z.number().int(),
		/** Chiqish bergan javoblar soni (bekor qilingan javob hisoblanmaydi). */
		responseTurns: z.number().int().nullable(),
		durationMs: z.number().int().nullable(),
		tokens: CallFullSessionTokensSchema,
		errorMessage: z.string().nullable(),
		startedAt: z.string().datetime(),
		endedAt: z.string().datetime().nullable(),
	})
	.openapi("CallFullSession");

// ===========================================
// Cost
// ===========================================

/**
 * Bu qo'ng'iroqning AI xarajati, o'qish paytida joriy narxlar bo'yicha
 * hisoblanadi (lib/ai-cost) — narxni tuzatish bu sahifani ham qayta narxlaydi.
 * Hisoblab bo'lmagan qiymat null, hech qachon 0 emas.
 */
export const CallFullCostSchema = z
	.object({
		voiceCostUsd: z.number().nullable(),
		transcriptionCostUsd: z.number().nullable(),
		/** Gemini transkripsiyani suhbat ichida bajaradi — alohida to'lov yo'q, 0 emas. */
		transcriptionNotApplicable: z.boolean(),
		analysisCostUsd: z.number().nullable(),
		totalCostUsd: z.number().nullable(),
		costPerMinuteUsd: z.number().nullable(),
		/** Null — kurs sozlanmagan (o'ylab topilgan kurs yo'qidan yomonroq). */
		totalCostUzs: z.number().nullable(),
		/** Kirish narxi taqsimlangan — taxminiy. Chiqish narxi aniq. */
		estimated: z.boolean(),
		unpricedReason: z.string().nullable(),
		cachedSharePct: z.number().nullable(),
		freshPromptTokens: z.number().int().nullable(),
		cachedPromptTokens: z.number().int().nullable(),
		freshAudioTokens: z.number().int().nullable(),
		freshTextTokens: z.number().int().nullable(),
		cachedAudioTokens: z.number().int().nullable(),
		cachedTextTokens: z.number().int().nullable(),
		/** API ga haqiqatan murojaat qilgan tahlil yugurishlari soni. */
		analysisBilledRuns: z.number().int(),
	})
	.openapi("CallFullCost");

// ===========================================
// What was actually done on the call
// ===========================================

export const CallFullTicketSchema = z
	.object({
		id: uuidSchema,
		subject: z.string(),
		description: z.string(),
		category: z.string().nullable(),
		priority: ticketPriorityEnum,
		status: ticketStatusEnum,
		externalRefId: z.string().nullable(),
		createdAt: z.string().datetime(),
		closedAt: z.string().datetime().nullable(),
	})
	.openapi("CallFullTicket");

export const CallFullTransferSchema = z
	.object({
		id: uuidSchema,
		toExtension: z.string(),
		toOperator: NamedOperatorSchema.nullable(),
		/** AI nima uchun odamga uzatgani — tool chaqiruvidan yozilgan. */
		reason: z.string().nullable(),
		/** Natija: connected — ulandi, failed/abandoned — ulanmadi. */
		status: transferStatusEnum,
		requestedAt: z.string().datetime(),
		connectedAt: z.string().datetime().nullable(),
		endedAt: z.string().datetime().nullable(),
		/** So'rovdan ulanishgacha ketgan soniya. Null — ulanmagan. */
		waitSeconds: z.number().int().nullable(),
		/** Ulangandan tugaguncha ketgan soniya. Null — ulanmagan yoki tugamagan. */
		talkSeconds: z.number().int().nullable(),
	})
	.openapi("CallFullTransfer");

export const CallFullFollowUpSchema = z
	.object({
		id: uuidSchema,
		title: z.string(),
		description: z.string().nullable(),
		dueAt: z.string().datetime().nullable(),
		status: followUpStatusEnum,
		/** true — AI yaratgan, false — operator qo'lda kiritgan. */
		createdBySystem: z.boolean(),
		isOverdue: z.boolean(),
		assignee: NamedOperatorSchema.nullable(),
		ticketId: uuidSchema.nullable(),
		createdAt: z.string().datetime(),
		completedAt: z.string().datetime().nullable(),
	})
	.openapi("CallFullFollowUp");

export const CallFullBookingSchema = z
	.object({
		id: uuidSchema,
		title: z.string(),
		notes: z.string().nullable(),
		scheduledAt: z.string().datetime(),
		endsAt: z.string().datetime(),
		durationMinutes: z.number().int(),
		location: z.string().nullable(),
		status: bookingStatusEnum,
		createdBySystem: z.boolean(),
		assignee: NamedOperatorSchema.nullable(),
		ticketId: uuidSchema.nullable(),
		createdAt: z.string().datetime(),
	})
	.openapi("CallFullBooking");

export const CallFullNoteSchema = z
	.object({
		id: uuidSchema,
		authorType: noteAuthorTypeEnum,
		/** Null — AI yoki tizim yozgan (author_type shuni aytadi). */
		author: NamedUserSchema.nullable(),
		content: z.string(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.openapi("CallFullNote");

/**
 * Qo'ng'iroq davomida bajarilgan ishlar.
 *
 * `ticket` yakka: bitta qo'ng'iroqda `calls.ticket_id` bitta, AI ning create_ticket
 * tool'i esa ataylab idempotent. Ticket'ni kim yaratgani (AI yoki operator)
 * saqlanmaydi — `tickets.created_by` javobgar odamni ko'rsatadi, muallifni emas
 * (lib/telephony/crm-writer.ts: resolveSystemActorUserId), shuning uchun bu yerda
 * muallif da'vo qilinmaydi. Follow-up, booking va note'larda esa bu ma'lum:
 * `createdBySystem` va `authorType`.
 *
 * O'chirilgan ticket bu yerda null bo'ladi, `call.ticketId` esa o'z qiymatida
 * qoladi — bu ziddiyat emas: id qatorda nima yozilganini, `ticket` esa hozir
 * nima ochilishi mumkinligini aytadi.
 */
export const CallFullActionsSchema = z
	.object({
		ticket: CallFullTicketSchema.nullable(),
		transfers: z.array(CallFullTransferSchema),
		followUps: z.array(CallFullFollowUpSchema),
		bookings: z.array(CallFullBookingSchema),
		notes: z.array(CallFullNoteSchema),
		counts: z.object({
			tickets: z.number().int(),
			transfers: z.number().int(),
			followUps: z.number().int(),
			bookings: z.number().int(),
			notes: z.number().int(),
		}),
		/** Hech qanday ish qilinmagan bo'lsa true — UI bo'sh holatni shu bilan chizadi. */
		isEmpty: z.boolean(),
	})
	.openapi("CallFullActions");

// ===========================================
// Envelope
// ===========================================

export const CallFullSchema = z
	.object({
		call: CallFullCallSchema,
		/** Asosiy yozuv. Null — yozuv yo'q. */
		recording: CallFullRecordingSchema.nullable(),
		/** Barcha fayllar: uzatishdan keyin bitta qo'ng'iroqda ikkitasi bo'lishi mumkin. */
		recordings: z.array(CallFullRecordingSchema),
		transcripts: CallFullTranscriptsSchema,
		analysis: CallFullAnalysisSchema.nullable(),
		session: CallFullSessionSchema.nullable(),
		/**
		 * Null ikki xil sababdan bo'ladi va ularni farqlash uchun `costVisible` bor:
		 * costVisible=false — rol xarajatni ko'ra olmaydi, costVisible=true va cost=null
		 * — narxlanadigan hech narsa yo'q (AI sessiyasi ham, tahlil ham bo'lmagan).
		 */
		cost: CallFullCostSchema.nullable(),
		/**
		 * Xarajatni faqat supervisor va admin ko'radi — /ai-costs bilan bir xil qoida.
		 * Manager uchun false: xarajat sahifasi rad etilgan rol o'sha raqamni bu yerdan
		 * ham o'qimasligi kerak.
		 */
		costVisible: z.boolean(),
		actions: CallFullActionsSchema,
	})
	.openapi("CallFull");

export const FullOutSchema = z.object({
	success: z.literal(true),
	data: CallFullSchema,
});

export const FullQuerySchema = z.object({
	/**
	 * Oraliq (isFinal=false) transkript qatorlarini ham qo'shish. Default: faqat
	 * yakuniy qatorlar — /transcripts/call/{callId} bilan bir xil xatti-harakat.
	 */
	includeInterim: z
		.enum(["true", "false"])
		.optional()
		.openapi({ param: { name: "includeInterim", in: "query" } }),
});

export type CallFull = z.infer<typeof CallFullSchema>;
export type CallFullRecording = z.infer<typeof CallFullRecordingSchema>;
export type CallFullTranscriptLine = z.infer<typeof CallFullTranscriptLineSchema>;
export type CallFullTransfer = z.infer<typeof CallFullTransferSchema>;
export type CallFullActions = z.infer<typeof CallFullActionsSchema>;
export type FullQuery = z.infer<typeof FullQuerySchema>;
