// biome-ignore-all lint/style/useNamingConvention: tool and property names are wire identifiers - the model emits them exactly as written here, so they cannot be renamed to satisfy a casing rule.
/**
 * Function-calling tools for the AI receptionist.
 *
 * Two representations of the same eight tools live here, and they must stay in
 * lockstep:
 *
 *   TOOL_DEFINITIONS - GA Realtime shape, sent in `session.update`. This is
 *                      JSON Schema as OpenAI wants it: flat objects, no $ref,
 *                      no oneOf, `additionalProperties: false`.
 *   TOOL_VALIDATORS  - one zod v4 schema per tool, used by the orchestrator to
 *                      validate the arguments the model actually produced
 *                      before anything touches the database.
 *
 * The second is not redundant. A model can and does emit a missing required
 * field, an empty string, a category it invented, or "tomorrow at 3" where an
 * ISO timestamp was asked for. The JSON Schema is a hint to the model; the zod
 * schema is the boundary that protects `tickets`, `bookings` and
 * `follow_up_tasks`.
 *
 * NO business vocabulary is baked into either representation. Ticket categories
 * belong to the business, not to this file: they arrive from
 * `ai_agent_profiles.ticket_categories`, are advertised to the model through
 * buildToolDefinitions(), and are checked at execution time with
 * resolveTicketCategory(). Baking them into a zod enum would mean a code change
 * every time a customer renamed one.
 */
import { z } from "zod/v4";

// ===========================================
// Shared vocabularies
// ===========================================

/**
 * Categories for a deployment that has configured none of its own.
 *
 * `tickets.category` is a varchar, so whatever the profile says lands in the
 * column verbatim. This list is only the last resort - no profile row at all -
 * and it is deliberately generic enough for a clinic, a taxi firm or a shop to
 * live with until the owner edits it. It mirrors DEFAULT_PROFILE.ticketCategories
 * and is duplicated here on purpose: this module must not import the database.
 */
export const FALLBACK_TICKET_CATEGORIES: readonly string[] = [
	"Umumiy savol",
	"Shikoyat",
	"Buyurtma",
	"Texnik yordam",
	"Boshqa",
];

/** Mirrors ticket_priority in the database. */
export const TICKET_PRIORITIES = ["low", "medium", "high"] as const;

export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/**
 * What a campaign call produced, as the AGENT can know it from the conversation.
 *
 * These are the outcomes a person's own words decide. The ones the channel
 * decides - nobody answered, the line was busy, the number does not exist - are
 * not here on purpose: the model never heard those, so offering them would let
 * it report a no-answer on a call it just held a conversation on. Those live
 * with the dialer (OUTBOUND_CHANNEL_OUTCOMES in lib/telephony/outbound.ts).
 *
 * "opt_out" is the one with teeth: it means "never ring this number again" and
 * it is what puts the number on the do-not-call list. It is deliberately a
 * separate value from "refused", because "I'm not interested today" and "take me
 * off your list" are different instructions and a business that treats them the
 * same is the reason people stop answering the phone.
 */
export const OUTBOUND_CALL_OUTCOMES = [
	"agreed",
	"call_back",
	"refused",
	"opt_out",
	"wrong_person",
	"answered",
	"voicemail",
] as const;

export type OutboundCallOutcome = (typeof OUTBOUND_CALL_OUTCOMES)[number];

/** Every tool the model may call, in the order they are advertised. */
export const TOOL_NAMES = [
	"search_knowledge_base",
	"save_contact_details",
	"create_ticket",
	"add_note",
	"create_follow_up",
	"book_appointment",
	"transfer_to_human",
	"end_call",
	// Advertised on outbound campaign calls only - see buildToolDefinitions.
	"record_call_outcome",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// ===========================================
// GA Realtime tool definitions
// ===========================================

/** The subset of JSON Schema the Realtime API accepts for a parameter. */
export interface ToolParameterSchema {
	type: "string" | "number" | "integer" | "boolean";
	description: string;
	enum?: string[];
	minimum?: number;
	maximum?: number;
}

export interface ToolParametersSchema {
	type: "object";
	properties: Record<string, ToolParameterSchema>;
	required: string[];
	additionalProperties: false;
}

/** GA Realtime tool entry: flat, with `name` on the tool itself. */
export interface RealtimeToolDefinition {
	type: "function";
	name: ToolName;
	description: string;
	parameters: ToolParametersSchema;
}

const PRIORITY_ENUM = [...TICKET_PRIORITIES];

/**
 * The tools as advertised before a business is known.
 *
 * create_ticket's `category` deliberately carries no `enum` here: the allowed
 * values are the profile's, and buildToolDefinitions() fills them in per call.
 * Sending this list unchanged (no profile row, or a test) still works - the
 * orchestrator validates the category it gets back either way.
 *
 * This is the set EVERY call gets, in both directions. The one campaign-only
 * tool is kept out of it (see OUTBOUND_TOOL_DEFINITIONS) so an inbound caller's
 * session is byte-for-byte the session it was before outbound calls existed.
 */
export const TOOL_DEFINITIONS: readonly RealtimeToolDefinition[] = [
	{
		type: "function",
		name: "search_knowledge_base",
		description:
			"Look up what THIS business has actually said about itself: prices, opening hours, " +
			"address, services, rules, what is available. Call it for any question about the " +
			"business that the knowledge section of your instructions does not already answer, " +
			"and call it BEFORE saying anything about it. You may not answer such a question " +
			"from your own general knowledge. When it finds nothing, follow the unknown-question " +
			"policy in your instructions instead of guessing.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"The caller's question in their own words, or the two or three words that matter in it, in the language they used. Example: yakshanba kuni ishlaysizmi.",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "save_contact_details",
		description:
			"Save or correct what is known about the caller: their name and, when the request " +
			"needs one, their address (tuman / ko'cha / uy), plus an alternative callback " +
			"number. Call it as soon as a detail is learned, field by field - do not wait for " +
			"the end of the call. Only send the fields the caller actually gave you.",
		parameters: {
			type: "object",
			properties: {
				firstName: {
					type: "string",
					description: "Caller's first name (ism) as they said it.",
				},
				lastName: {
					type: "string",
					description: "Caller's family name (familiya) as they said it.",
				},
				tuman: {
					type: "string",
					description: "District, without the word 'tumani'. Example: Yunusobod.",
				},
				kocha: {
					type: "string",
					description: "Street, without the word 'ko'chasi'. Example: Amir Temur.",
				},
				uy: {
					type: "string",
					description:
						"House or building number, with the entrance or flat if given. Example: 12A, 45-kvartira.",
				},
				altPhone: {
					type: "string",
					description:
						"A callback number that differs from the number they are calling from, in the form they dictated.",
				},
			},
			required: [],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "create_ticket",
		description:
			"Register the caller's request once you know what they want, which category it is, " +
			"and they have CONFIRMED the details you read back to them. Say a short line " +
			"first, then call this. Call it once per call unless the caller raises two " +
			"genuinely unrelated matters. Do not tell the caller any reference number - " +
			"there is none.",
		parameters: {
			type: "object",
			properties: {
				subject: {
					type: "string",
					description:
						"One short line, about ten words, naming what the caller wants. Example: Buyurtma yetib kelmagan, mijoz qayta yuborishni so'raydi.",
				},
				description: {
					type: "string",
					description:
						"The facts a colleague needs to act on it: what the caller wants, exactly where if a place matters, since when, and the callback number.",
				},
				category: {
					type: "string",
					description:
						"Exactly one of this business's own categories, spelled as listed in the CATEGORIES section of your instructions. Do not translate it and do not invent one.",
				},
				priority: {
					type: "string",
					description:
						"high when somebody is in danger or the caller is losing money or time right now; medium for a normal request; low for a question or a long-standing matter.",
					enum: PRIORITY_ENUM,
				},
			},
			required: ["subject", "description", "category", "priority"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "add_note",
		description:
			"Attach a short note to the call for the colleague who reads it later: anything " +
			"useful that does not belong in the request text, such as the caller being " +
			"elderly, an entrance code, or the best time to reach them.",
		parameters: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description: "The note, one or two sentences, in the language of the call.",
				},
			},
			required: ["content"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "create_follow_up",
		description:
			"Create a task for a colleague on our side to call this caller back, when the " +
			"request cannot be closed on this call - including when they asked something the " +
			"business has given you no answer to. Never tell the caller a guaranteed time.",
		parameters: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description:
						"What has to be done, one short line. Example: Mijozga narx bo'yicha javob berish.",
				},
				description: {
					type: "string",
					description: "Extra context for whoever picks the task up.",
				},
				dueAt: {
					type: "string",
					description:
						"When it should be done by, as a full ISO-8601 timestamp with the +05:00 offset. Example: 2026-08-05T10:00:00+05:00.",
				},
			},
			required: ["title"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "book_appointment",
		description:
			"Book a visit, a meeting or an appointment slot, but only after the caller has " +
			"agreed to a concrete date and time. Never invent availability: only offer a slot " +
			"the business has actually told you about, and never present a booking as a " +
			"guarantee of an outcome.",
		parameters: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "What the appointment is for, one short line.",
				},
				scheduledAt: {
					type: "string",
					description:
						"Start of the appointment as a full ISO-8601 timestamp with the +05:00 offset. Example: 2026-08-06T09:30:00+05:00.",
				},
				durationMinutes: {
					type: "integer",
					description: "Expected length in minutes. Defaults to 30 when omitted.",
					minimum: 5,
					maximum: 480,
				},
				location: {
					type: "string",
					description: "Where the meeting happens, if it is not the caller's own address.",
				},
				notes: {
					type: "string",
					description: "Anything the visiting staff member should know beforehand.",
				},
			},
			required: ["title", "scheduledAt"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "transfer_to_human",
		description:
			"Hand the live call to a human colleague. Use it whenever the caller asks for a " +
			"person, is distressed, money is involved, somebody is in danger, or the business " +
			"has given you no answer and its policy is to transfer. Say one short line to the " +
			"caller first, then call this and stop talking.",
		parameters: {
			type: "object",
			properties: {
				reason: {
					type: "string",
					description:
						"Why the call is being handed over, one factual line for the colleague's screen.",
				},
				preferredExtension: {
					type: "string",
					description:
						"Leave this out unless the caller named a specific extension, or a colleague is already handling their case. Without it the platform picks whoever is free.",
				},
			},
			required: ["reason"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "end_call",
		description:
			"Hang up. Only after the caller has confirmed there is nothing else, or has said " +
			"goodbye. Say goodbye yourself first, then call this.",
		parameters: {
			type: "object",
			properties: {
				reason: {
					type: "string",
					description:
						"Short reason the call is ending. Example: caller_satisfied, caller_hung_up, wrong_number.",
				},
			},
			required: ["reason"],
			additionalProperties: false,
		},
	},
];

/**
 * The one tool a campaign call gets and an inbound call never sees.
 *
 * WHY IT IS ITS OWN TOOL, and not a field on end_call or a note.
 *
 * 1. It has to be recordable the INSTANT the person says it, not when the call
 *    ends politely. "Meni ro'yxatdan chiqaring" is followed by a hung-up phone
 *    far more often than by a goodbye, and an opt-out that only reached the
 *    database on a graceful end_call would lose exactly the refusals that matter
 *    most - the angry ones. A separate tool can be called mid-conversation and
 *    the call can then die however it likes.
 * 2. An outcome is a fact about the CONVERSATION, and nothing existing records
 *    one. create_ticket writes a work item somebody has to close; add_note
 *    writes prose. Counting refusals, callbacks and opt-outs off either would
 *    mean a machine re-reading text a model wrote, which is not a measurement.
 * 3. The opt-out and the outcome are ONE decision by the person, so they are one
 *    write. Splitting them across two tools would let a call record "refused"
 *    and lose "and never call me again" in between.
 *
 * It is not offered on inbound calls: there is no campaign row for an inbound
 * call to write an outcome to, and a tool the model can call but nothing can act
 * on is worse than a missing one.
 */
export const OUTBOUND_TOOL_DEFINITIONS: readonly RealtimeToolDefinition[] = [
	{
		type: "function",
		name: "record_call_outcome",
		description:
			"Record what this outbound call produced, in ONE call, as soon as the person's " +
			"answer is clear - then say your closing line and call end_call. This is the only " +
			"record the business gets of what they said, so it must be honest: never report " +
			"agreement that was not given. If they ask not to be called again, use " +
			'"opt_out" immediately, even if they then hang up mid-sentence.',
		parameters: {
			type: "object",
			properties: {
				outcome: {
					type: "string",
					description:
						'What the person decided. "agreed" - they said yes to what you called about. ' +
						'"call_back" - they asked to be called another time. "refused" - not interested, ' +
						'but they did not ask to be taken off the list. "opt_out" - they asked never to be ' +
						'called again, in any wording. "wrong_person" - this number is not the person you ' +
						'were calling, or they know nothing about the matter. "answered" - you spoke but ' +
						'they decided nothing. "voicemail" - a machine answered, not a person.',
					enum: [...OUTBOUND_CALL_OUTCOMES],
				},
				reason: {
					type: "string",
					description:
						"One short line for the colleague who reads this, in the language of the call, in the person's own terms. Example: hozir band, kechqurun qo'ng'iroq qilishni so'radi.",
				},
				callBackAt: {
					type: "string",
					description:
						"Only when the outcome is call_back AND they named a time: that time as a full ISO-8601 timestamp with the +05:00 offset. Leave it out if they did not name one - do not invent a time.",
				},
			},
			required: ["outcome", "reason"],
			additionalProperties: false,
		},
	},
];

// ===========================================
// Argument validators
// ===========================================

/** Trimmed, non-empty, length-capped free text. */
function textField(max: number) {
	return z.string().trim().min(1).max(max);
}

/**
 * Every character a speech model reaches for when it writes an Uzbek apostrophe.
 *
 * This matters more than it looks. A business category like "Yo'lda nosozlik" is
 * matched as a string, and Uzbek Latin has four plausible spellings of the same
 * apostrophe: the ASCII quote a dashboard form produces, the official modifier
 * letter turned comma U+02BB ("Yoʻl"), and the two typographic curly quotes
 * U+2018/U+2019 that any model trained on prose will produce. A model that
 * answers "Yoʻl" is not wrong about the category - it is right, spelled
 * correctly, and would fail a raw string comparison. Failing it means telling the
 * caller "kechirasiz, qaytaring" about a category they never mentioned, so the
 * spelling is normalised instead.
 */
const APOSTROPHE_VARIANTS = /[ʹʻʼˈ‘’`´']/g;

/** Canonical lookup key for a category or priority the model produced. */
function normaliseVocabulary(value: string): string {
	return value.trim().replace(APOSTROPHE_VARIANTS, "'").toLowerCase();
}

// ===========================================
// The business's own categories
// ===========================================

/** Longest a single owner-entered category may be; longer is a paste accident. */
const MAX_CATEGORY_CHARS = 120;

/** How many categories one profile may advertise to the model. */
const MAX_CATEGORY_COUNT = 24;

/**
 * The business's categories, cleaned up for use as a vocabulary.
 *
 * Owner-entered data: blank rows, duplicates that differ only in case, and an
 * accidental essay in the field all have to be survivable, because the
 * alternative is a session.update the API rejects for the whole call.
 */
export function normaliseTicketCategories(categories: readonly string[]): string[] {
	const seen = new Set<string>();
	const cleaned: string[] = [];

	for (const raw of categories) {
		if (typeof raw !== "string") {
			continue;
		}

		const category = raw.trim().slice(0, MAX_CATEGORY_CHARS);
		const key = normaliseVocabulary(category);

		if (category.length === 0 || seen.has(key)) {
			continue;
		}

		seen.add(key);
		cleaned.push(category);

		if (cleaned.length >= MAX_CATEGORY_COUNT) {
			break;
		}
	}

	return cleaned;
}

/**
 * The category as the business spells it, from whatever the model sent, or null
 * when it is genuinely not one of theirs.
 *
 * `categories` is `profile.ticketCategories`, so this is a per-call decision made
 * at execution time - which is the whole reason there is no enum in the zod
 * schema. An empty list falls back to the generic set rather than rejecting every
 * ticket a misconfigured profile would produce.
 */
export function resolveTicketCategory(
	value: string,
	categories: readonly string[] = FALLBACK_TICKET_CATEGORIES
): string | null {
	const key = normaliseVocabulary(value);

	if (key.length === 0) {
		return null;
	}

	const cleaned = normaliseTicketCategories(categories);
	const pool = cleaned.length > 0 ? cleaned : FALLBACK_TICKET_CATEGORIES;

	for (const category of pool) {
		if (normaliseVocabulary(category) === key) {
			return category;
		}
	}

	return null;
}

/** Which extra tools this call needs beyond the shared eight. */
export interface ToolDefinitionOptions {
	/**
	 * True when the platform placed this call as part of a campaign.
	 *
	 * Defaults to false, so every existing caller keeps the exact eight-tool
	 * session it had before.
	 */
	outbound?: boolean;
}

/**
 * The tool list for one business, on one call.
 *
 * Only create_ticket differs per business: its `category` gains the enum of the
 * business's own categories, which is what stops the model inventing a sixth one
 * in the first place. Everything else is shared, so the wire shape stays exactly
 * what the GA endpoint accepted before.
 *
 * The direction adds at most one tool. It is appended rather than woven in so the
 * order of the shared eight - which the model's own prompt cache keys on - never
 * changes.
 */
export function buildToolDefinitions(
	categories: readonly string[],
	options: ToolDefinitionOptions = {}
): RealtimeToolDefinition[] {
	const allowed = normaliseTicketCategories(categories);
	const extra = options.outbound === true ? OUTBOUND_TOOL_DEFINITIONS : [];

	if (allowed.length === 0) {
		return [...TOOL_DEFINITIONS, ...extra];
	}

	const shared = TOOL_DEFINITIONS.map((tool) => {
		if (tool.name !== "create_ticket") {
			return tool;
		}

		const category = tool.parameters.properties.category;

		if (category === undefined) {
			return tool;
		}

		return {
			...tool,
			parameters: {
				...tool.parameters,
				properties: {
					...tool.parameters.properties,
					category: { ...category, enum: allowed },
				},
			},
		};
	});

	return [...shared, ...extra];
}

/**
 * The tool list for a call, given the session context the provider was started
 * with.
 *
 * Providers build their shared tool list once, in their constructor, from the
 * business profile - but whether this is a campaign call is a property of the
 * CALL, and it is not known until start(context). This reconciles the two at the
 * moment the session is configured, which is the only point where both are in
 * hand.
 *
 * Derived from the context rather than plumbed through as a separate flag on
 * purpose: `context.campaign` is the same field that makes the prompt say why it
 * is calling, so the tool and the instructions that tell the model to use it can
 * never disagree about whether this is an outbound call.
 *
 * Idempotent, and a no-op on every inbound call.
 */
export function toolsForCall(
	shared: readonly RealtimeToolDefinition[],
	context: { campaign?: unknown }
): readonly RealtimeToolDefinition[] {
	if (context.campaign === undefined || context.campaign === null) {
		return shared;
	}

	if (shared.some((tool) => tool.name === "record_call_outcome")) {
		return shared;
	}

	return [...shared, ...OUTBOUND_TOOL_DEFINITIONS];
}

/**
 * Priority words the model reaches for that are not the three enum values.
 *
 * Only unambiguous synonyms are mapped: the point is to keep a genuine "this is
 * urgent" from being flattened, not to guess at anything. Anything unrecognised
 * falls back to "medium" in the schema below rather than failing the call.
 */
const PRIORITY_SYNONYMS: Record<string, TicketPriority> = {
	urgent: "high",
	critical: "high",
	emergency: "high",
	immediate: "high",
	shoshilinch: "high",
	favqulodda: "high",
	normal: "medium",
	standard: "medium",
	moderate: "medium",
	oddiy: "medium",
	minor: "low",
	cosmetic: "low",
	past: "low",
};

const PRIORITY_BY_KEY = new Map<string, TicketPriority>(
	TICKET_PRIORITIES.map((priority) => [priority, priority])
);

/** The enum value for whatever the model called the priority, or null. */
export function resolveTicketPriority(value: string): TicketPriority | null {
	const key = normaliseVocabulary(value);

	return PRIORITY_BY_KEY.get(key) ?? PRIORITY_SYNONYMS[key] ?? null;
}

/**
 * Optional text that tolerates the model sending "" or a whitespace-only
 * string for "I do not know this yet": both collapse to undefined instead of
 * writing an empty value over a good one.
 */
function optionalTextField(max: number) {
	return z
		.string()
		.max(max)
		.transform((value) => value.trim())
		.transform((value) => (value.length === 0 ? undefined : value))
		.optional();
}

/**
 * ISO-8601 date-time, with the time separator allowed to be a space (the model
 * writes "2026-08-05 10:00:00+05:00" often enough to be worth accepting) and
 * the zone optional.
 *
 * The shape check is not decoration: `Date.parse` is specified to accept
 * implementation-defined formats, and it happily turns "tomorrow at 3" into
 * 2001-02-28 on both V8 and JSC. Without this regex a vague answer from the
 * model becomes a booking twenty-five years in the past instead of a validation
 * error the model can be asked to correct.
 */
const ISO_TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?$/;

const HAS_TIME_ZONE_PATTERN = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * Uzbekistan is UTC+5 all year (no daylight saving), so a timestamp the model
 * sent without a zone is interpreted as business-local rather than as the
 * server's own time zone - which would silently shift every appointment if the
 * backend were ever deployed outside Tashkent.
 */
const AGENT_UTC_OFFSET = "+05:00";

/** Yesterday is the earliest sensible due date; anything earlier is a mistake. */
const MAX_PAST_MS = 24 * 60 * 60 * 1000;

/** Two years out. Beyond that the model has hallucinated a year. */
const MAX_FUTURE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** ISO-8601 in, canonical UTC ISO-8601 out, or null when unusable. */
function normaliseIsoTimestamp(value: string): string | null {
	const trimmed = value.trim();

	if (!ISO_TIMESTAMP_PATTERN.test(trimmed)) {
		return null;
	}

	const zoned = HAS_TIME_ZONE_PATTERN.test(trimmed) ? trimmed : `${trimmed}${AGENT_UTC_OFFSET}`;
	const parsed = Date.parse(zoned.replace(" ", "T"));

	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function isWithinPlausibleWindow(iso: string): boolean {
	const parsed = Date.parse(iso);

	if (Number.isNaN(parsed)) {
		return false;
	}

	const now = Date.now();

	return parsed >= now - MAX_PAST_MS && parsed <= now + MAX_FUTURE_MS;
}

const isoTimestamp = z
	.string()
	.trim()
	.min(1)
	.refine((value) => normaliseIsoTimestamp(value) !== null, {
		message: "expected an ISO-8601 timestamp, for example 2026-08-05T10:00:00+05:00",
	})
	.transform((value) => normaliseIsoTimestamp(value) ?? value)
	.refine((value) => isWithinPlausibleWindow(value), {
		message: "the timestamp must be no earlier than yesterday and within the next two years",
	});

/**
 * Lenient phone validation: the model transcribes what it heard, so spaces,
 * dashes and brackets all show up. Digits are what matter, and there have to be
 * at least seven of them.
 */
const altPhone = z
	.string()
	.trim()
	.min(5)
	.max(30)
	.refine((value) => (value.match(/\d/g) ?? []).length >= 7, {
		message: "expected at least 7 digits in the phone number",
	});

export const SaveContactDetailsArgsSchema = z
	.object({
		firstName: optionalTextField(100),
		lastName: optionalTextField(100),
		tuman: optionalTextField(100),
		kocha: optionalTextField(150),
		uy: optionalTextField(50),
		altPhone: altPhone.optional(),
	})
	.refine(
		(value) =>
			value.firstName !== undefined ||
			value.lastName !== undefined ||
			value.tuman !== undefined ||
			value.kocha !== undefined ||
			value.uy !== undefined ||
			value.altPhone !== undefined,
		{ message: "save_contact_details needs at least one field" }
	);

export const CreateTicketArgsSchema = z.object({
	subject: textField(255),
	description: textField(4000),
	// Deliberately NOT an enum: the allowed categories belong to the business, are
	// read from its profile on every call, and are checked by the orchestrator with
	// resolveTicketCategory() before anything is written. All this schema
	// guarantees is that a non-empty string of a sane length arrived.
	category: textField(MAX_CATEGORY_CHARS),
	// Defaulted rather than required: a model that omits the priority, or invents
	// a word for it, must not cost the citizen their complaint. An unrecognised
	// word becomes "medium" - the operator still sees the full description, and a
	// wrong-but-present ticket beats a failed tool call.
	priority: z
		.string()
		.trim()
		.transform((value) => resolveTicketPriority(value) ?? "medium")
		.default("medium"),
});

/**
 * The caller's question, on its way to the knowledge base.
 *
 * Capped rather than picked apart: the retrieval side tokenises and drops stop
 * words itself, so all this has to refuse is an empty query (which would match
 * everything) and a runaway one.
 */
export const SearchKnowledgeBaseArgsSchema = z.object({
	query: textField(300),
});

export const AddNoteArgsSchema = z.object({
	content: textField(2000),
});

export const CreateFollowUpArgsSchema = z.object({
	title: textField(255),
	description: optionalTextField(2000),
	dueAt: isoTimestamp.optional(),
});

export const BookAppointmentArgsSchema = z.object({
	title: textField(255),
	scheduledAt: isoTimestamp,
	durationMinutes: z.coerce.number().int().min(5).max(480).default(30),
	location: optionalTextField(255),
	notes: optionalTextField(2000),
});

/**
 * Placeholders for a reason the model forgot to send.
 *
 * Both tools change what happens to the live call, and neither may fail over a
 * missing label: a rejected transfer_to_human leaves a caller who asked for a
 * person listening to a machine, and a rejected end_call leaves a finished call
 * open until the inactivity timer kills it. The text is deliberately flat and
 * says only that nothing was stated - an invented reason would be worse than no
 * reason, because the operator reads this one on their screen.
 */
const MISSING_TRANSFER_REASON = "Sabab ko'rsatilmadi (AI operatorga uladi)";
const MISSING_END_CALL_REASON = "unspecified";

export const TransferToHumanArgsSchema = z.object({
	reason: optionalTextField(500).transform((value) => value ?? MISSING_TRANSFER_REASON),
	preferredExtension: z
		.string()
		.trim()
		.regex(/^\d{3,6}$/, { message: "an extension is 3 to 6 digits" })
		.optional(),
});

export const EndCallArgsSchema = z.object({
	reason: optionalTextField(200).transform((value) => value ?? MISSING_END_CALL_REASON),
});

/**
 * Words the model reaches for that mean one of the seven outcomes.
 *
 * Only unambiguous ones, and every phrasing that means "stop calling me" is
 * mapped, because that is the one this table exists for: a model that answers
 * "do_not_call" instead of "opt_out" must not have the request thrown away as a
 * validation error. The other direction is never guessed - see the schema below.
 */
const OUTCOME_SYNONYMS: Record<string, OutboundCallOutcome> = {
	yes: "agreed",
	accepted: "agreed",
	interested: "agreed",
	success: "agreed",
	razi: "agreed",
	callback: "call_back",
	"call-back": "call_back",
	later: "call_back",
	reschedule: "call_back",
	keyinroq: "call_back",
	no: "refused",
	declined: "refused",
	rejected: "refused",
	not_interested: "refused",
	"not-interested": "refused",
	do_not_call: "opt_out",
	"do-not-call": "opt_out",
	dnc: "opt_out",
	unsubscribe: "opt_out",
	stop: "opt_out",
	blacklist: "opt_out",
	remove: "opt_out",
	optout: "opt_out",
	"opt-out": "opt_out",
	wrong_number: "wrong_person",
	"wrong-number": "wrong_person",
	wrongperson: "wrong_person",
	"wrong-person": "wrong_person",
	spoke: "answered",
	contacted: "answered",
	answering_machine: "voicemail",
	"answering-machine": "voicemail",
	machine: "voicemail",
	voice_mail: "voicemail",
};

const OUTCOME_BY_KEY = new Map<string, OutboundCallOutcome>(
	OUTBOUND_CALL_OUTCOMES.map((outcome) => [outcome, outcome])
);

/** The outcome value for whatever the model called it, or null. */
export function resolveOutboundOutcome(value: string): OutboundCallOutcome | null {
	const key = normaliseVocabulary(value).replace(/\s+/g, "_");

	return OUTCOME_BY_KEY.get(key) ?? OUTCOME_SYNONYMS[key] ?? null;
}

/** Placeholder for an outcome the model recorded without saying why. */
const MISSING_OUTCOME_REASON = "Sabab ko'rsatilmadi";

/**
 * Deliberately NOT defaulted the way create_ticket's priority is.
 *
 * A priority nobody stated can safely become "medium" - the operator still reads
 * the whole description. An outcome nobody stated cannot safely become anything:
 * defaulting an unrecognised word to "answered" would file a refusal as a
 * conversation and an opt-out as a shrug, and the person would be rung again. So
 * an unknown value is refused with the list in the error, which is a turn the
 * model can correct - and the enum is advertised in the tool itself, so it
 * almost never has to.
 */
export const RecordCallOutcomeArgsSchema = z.object({
	outcome: z
		.string()
		.trim()
		.min(1)
		.refine((value) => resolveOutboundOutcome(value) !== null, {
			message: `outcome must be one of: ${OUTBOUND_CALL_OUTCOMES.join(", ")}`,
		})
		.transform((value) => resolveOutboundOutcome(value) as OutboundCallOutcome),
	reason: optionalTextField(500).transform((value) => value ?? MISSING_OUTCOME_REASON),
	callBackAt: isoTimestamp.optional(),
});

export type SearchKnowledgeBaseArgs = z.output<typeof SearchKnowledgeBaseArgsSchema>;
export type SaveContactDetailsArgs = z.output<typeof SaveContactDetailsArgsSchema>;
export type CreateTicketArgs = z.output<typeof CreateTicketArgsSchema>;
export type AddNoteArgs = z.output<typeof AddNoteArgsSchema>;
export type CreateFollowUpArgs = z.output<typeof CreateFollowUpArgsSchema>;
export type BookAppointmentArgs = z.output<typeof BookAppointmentArgsSchema>;
export type TransferToHumanArgs = z.output<typeof TransferToHumanArgsSchema>;
export type EndCallArgs = z.output<typeof EndCallArgsSchema>;
export type RecordCallOutcomeArgs = z.output<typeof RecordCallOutcomeArgsSchema>;

/**
 * Name -> validator, for the orchestrator's generic dispatch path. The
 * per-tool schemas above stay exported so a handler that knows which tool it is
 * handling keeps full type inference.
 */
export const TOOL_VALIDATORS: Record<ToolName, z.ZodType> = {
	search_knowledge_base: SearchKnowledgeBaseArgsSchema,
	save_contact_details: SaveContactDetailsArgsSchema,
	create_ticket: CreateTicketArgsSchema,
	add_note: AddNoteArgsSchema,
	create_follow_up: CreateFollowUpArgsSchema,
	book_appointment: BookAppointmentArgsSchema,
	transfer_to_human: TransferToHumanArgsSchema,
	end_call: EndCallArgsSchema,
	record_call_outcome: RecordCallOutcomeArgsSchema,
};

/** Type guard for a name that came off the wire. */
export function isToolName(value: string): value is ToolName {
	return (TOOL_NAMES as readonly string[]).includes(value);
}

export type ToolValidationResult =
	| { ok: true; name: ToolName; args: unknown }
	| { ok: false; error: string };

/**
 * Validate raw model arguments against the schema for `name`.
 *
 * Returns a result object rather than throwing: a bad tool call is a normal
 * event on a live call, and the orchestrator answers it by sending the error
 * text back to the model as the tool result so it can correct itself.
 */
export function validateToolArguments(name: string, args: unknown): ToolValidationResult {
	if (!isToolName(name)) {
		return { ok: false, error: `unknown tool "${name}"` };
	}

	const parsed = TOOL_VALIDATORS[name].safeParse(args ?? {});

	if (!parsed.success) {
		return { ok: false, error: z.prettifyError(parsed.error) };
	}

	return { ok: true, name, args: parsed.data };
}
