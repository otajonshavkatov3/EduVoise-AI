import { describe, expect, test } from "bun:test";
import { buildToolResultEnvelope } from "./openai-realtime";
import { buildToolAcknowledgement } from "./prompts";
import {
	buildToolDefinitions,
	FALLBACK_TICKET_CATEGORIES,
	normaliseTicketCategories,
	resolveTicketCategory,
	resolveTicketPriority,
	validateToolArguments,
} from "./tools";

/** One customer's categories - a taxi firm, spelled the way an owner would type them. */
const TAXI_CATEGORIES = [
	"Buyurtma",
	"Yo'lovchi shikoyati",
	"Haydovchi haqida",
	"Narx savoli",
	"Boshqa",
];

describe("business ticket categories", () => {
	test("every category the business configured is accepted unchanged", () => {
		for (const category of TAXI_CATEGORIES) {
			expect(resolveTicketCategory(category, TAXI_CATEGORIES)).toBe(category);
		}
	});

	test("accepts the apostrophe variants a speech model actually produces", () => {
		// U+02BB (the official Uzbek letter), U+2018 and U+2019 (typographic quotes)
		// and the ASCII backtick all mean the same word. Rejecting them would fail a
		// create_ticket over a correctly spelled category.
		expect(resolveTicketCategory("Yoʻlovchi shikoyati", TAXI_CATEGORIES)).toBe(
			"Yo'lovchi shikoyati"
		);
		expect(resolveTicketCategory("Yo‘lovchi shikoyati", TAXI_CATEGORIES)).toBe(
			"Yo'lovchi shikoyati"
		);
		expect(resolveTicketCategory("Yo’lovchi shikoyati", TAXI_CATEGORIES)).toBe(
			"Yo'lovchi shikoyati"
		);
		expect(resolveTicketCategory("Yo`lovchi shikoyati", TAXI_CATEGORIES)).toBe(
			"Yo'lovchi shikoyati"
		);
	});

	test("is case and whitespace tolerant", () => {
		expect(resolveTicketCategory("  buyurtma ", TAXI_CATEGORIES)).toBe("Buyurtma");
		expect(resolveTicketCategory("NARX SAVOLI", TAXI_CATEGORIES)).toBe("Narx savoli");
	});

	test("refuses a category this business does not have", () => {
		// The municipal words the old build had hardcoded are now exactly as invalid
		// as any other invention - a taxi firm never files a "Gaz" ticket.
		expect(resolveTicketCategory("Gaz", TAXI_CATEGORIES)).toBeNull();
		expect(resolveTicketCategory("Politsiya", TAXI_CATEGORIES)).toBeNull();
		expect(resolveTicketCategory("orders", TAXI_CATEGORIES)).toBeNull();
		expect(resolveTicketCategory("", TAXI_CATEGORIES)).toBeNull();
	});

	test("falls back to the generic set when a profile configured none", () => {
		expect(resolveTicketCategory("Shikoyat", [])).toBe("Shikoyat");
		expect(resolveTicketCategory("Buyurtma", FALLBACK_TICKET_CATEGORIES)).toBe("Buyurtma");
	});

	test("owner-entered noise cannot poison the vocabulary", () => {
		expect(normaliseTicketCategories(["  Buyurtma ", "", "buyurtma", "Shikoyat"])).toEqual([
			"Buyurtma",
			"Shikoyat",
		]);
	});
});

describe("tool definitions carry the business's categories", () => {
	function categoryProperty(tools: ReturnType<typeof buildToolDefinitions>) {
		const createTicket = tools.find((tool) => tool.name === "create_ticket");

		if (createTicket === undefined) {
			throw new Error("create_ticket is not advertised");
		}

		return createTicket.parameters.properties.category;
	}

	test("the enum is the profile's list, not a fixed one", () => {
		expect(categoryProperty(buildToolDefinitions(TAXI_CATEGORIES))?.enum).toEqual(TAXI_CATEGORIES);
	});

	test("a profile with no categories advertises no enum rather than a wrong one", () => {
		expect(categoryProperty(buildToolDefinitions([]))?.enum).toBeUndefined();
	});

	test("the knowledge lookup is advertised to the model", () => {
		const names = buildToolDefinitions(TAXI_CATEGORIES).map((tool) => tool.name);

		expect(names).toContain("search_knowledge_base");
	});
});

describe("search_knowledge_base validation", () => {
	test("a question is passed through, trimmed", () => {
		const result = validateToolArguments("search_knowledge_base", {
			query: "  yakshanba kuni ishlaysizmi  ",
		});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.args).toMatchObject({ query: "yakshanba kuni ishlaysizmi" });
		}
	});

	test("an empty query is refused: it would match every entry", () => {
		expect(validateToolArguments("search_knowledge_base", { query: "   " }).ok).toBe(false);
		expect(validateToolArguments("search_knowledge_base", {}).ok).toBe(false);
	});
});

describe("ticket priority normalisation", () => {
	test("maps unambiguous synonyms rather than losing the urgency", () => {
		expect(resolveTicketPriority("urgent")).toBe("high");
		expect(resolveTicketPriority("Shoshilinch")).toBe("high");
		expect(resolveTicketPriority("normal")).toBe("medium");
		expect(resolveTicketPriority("minor")).toBe("low");
	});

	test("passes the enum values through", () => {
		expect(resolveTicketPriority("HIGH")).toBe("high");
		expect(resolveTicketPriority(" low ")).toBe("low");
	});

	test("reports an unknown word as unknown", () => {
		expect(resolveTicketPriority("purple")).toBeNull();
	});
});

describe("create_ticket validation", () => {
	const base = {
		subject: "Buyurtma qilingan mashina yetib kelmadi",
		description: "Mijoz yarim soatdan beri kutmoqda, haydovchi javob bermayapti.",
	};

	test("the category is carried through as the business spelled it", () => {
		const result = validateToolArguments("create_ticket", {
			...base,
			category: "Yoʻlovchi shikoyati",
			priority: "high",
		});

		expect(result.ok).toBe(true);

		if (result.ok) {
			const args = result.args as { category: string };

			// The schema no longer owns the vocabulary; it only guarantees a usable
			// string reached the orchestrator, which resolves it against the profile.
			expect(resolveTicketCategory(args.category, TAXI_CATEGORIES)).toBe("Yo'lovchi shikoyati");
		}
	});

	test("an invented priority becomes medium instead of failing the ticket", () => {
		const result = validateToolArguments("create_ticket", {
			...base,
			category: "Buyurtma",
			priority: "very important",
		});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.args).toMatchObject({ category: "Buyurtma", priority: "medium" });
		}
	});

	test("a missing priority still defaults to medium", () => {
		const result = validateToolArguments("create_ticket", { ...base, category: "Buyurtma" });

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.args).toMatchObject({ priority: "medium" });
		}
	});

	test("an empty category is still refused before anything is written", () => {
		const result = validateToolArguments("create_ticket", {
			...base,
			category: "   ",
			priority: "high",
		});

		expect(result.ok).toBe(false);

		if (!result.ok) {
			expect(result.error).toContain("category");
		}
	});
});

describe("call-ending tools never fail over a missing label", () => {
	test("end_call without a reason is accepted", () => {
		const result = validateToolArguments("end_call", {});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.args).toMatchObject({ reason: "unspecified" });
		}
	});

	test("transfer_to_human without a reason is accepted and says so plainly", () => {
		const result = validateToolArguments("transfer_to_human", {});

		expect(result.ok).toBe(true);

		if (result.ok) {
			const args = result.args as { reason: string };

			expect(args.reason).toContain("Sabab ko'rsatilmadi");
		}
	});

	test("a reason that was given is kept verbatim", () => {
		const result = validateToolArguments("transfer_to_human", {
			reason: "Fuqaro operator bilan gaplashmoqchi",
		});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.args).toMatchObject({ reason: "Fuqaro operator bilan gaplashmoqchi" });
		}
	});
});

describe("tool result envelope", () => {
	test("a failure carries recovery guidance and a one-line error", () => {
		const envelope = buildToolResultEnvelope({
			ok: false,
			error: "invalid_type: expected string\n  at subject\n  received undefined",
		});

		expect(envelope.ok).toBe(false);
		expect(envelope.error).toBe("invalid_type: expected string at subject received undefined");
		expect(String(envelope.guidance)).toContain("Do not read this text aloud");
	});

	test("an orchestrator message is left to drive the recovery", () => {
		const envelope = buildToolResultEnvelope({
			ok: false,
			error: "no operator could be reached (noanswer)",
			message: "Tell the caller that no operator is free at the moment.",
		});

		// The generic reminder, not the "ask again for the missing detail" advice,
		// which would contradict the instruction the orchestrator already supplied.
		expect(String(envelope.guidance)).toContain("Internal data for you only");
		expect(envelope.message).toBe("Tell the caller that no operator is free at the moment.");
	});

	test("a success is passed through with the do-not-read reminder", () => {
		const envelope = buildToolResultEnvelope({ ok: true, created: true });

		expect(envelope).toMatchObject({ ok: true, created: true });
		expect(String(envelope.guidance)).toContain("Do not read");
	});

	test("a bare string invents no verdict", () => {
		const envelope = buildToolResultEnvelope("something went wrong");

		expect(envelope.ok).toBeUndefined();
		expect(envelope.note).toBe("something went wrong");
	});

	test("a long error is capped so it does not invite recitation", () => {
		const envelope = buildToolResultEnvelope({ ok: false, error: "x".repeat(2_000) });

		expect(String(envelope.error).length).toBeLessThanOrEqual(400);
	});
});

describe("spoken tool acknowledgements", () => {
	test("cover the tools that write to the CRM", () => {
		expect(buildToolAcknowledgement("uz", "create_ticket")).toBe(
			"Bir daqiqa, murojaatingizni ro'yxatga olaman."
		);
		expect(buildToolAcknowledgement("ru", "create_ticket")).toBe("Минутку, регистрирую обращение.");
	});

	test("follow the caller's language", () => {
		expect(buildToolAcknowledgement("ru-RU", "save_contact_details")).toBe("Минутку, записываю.");
		expect(buildToolAcknowledgement("uz", "save_contact_details")).toBe(
			"Bir daqiqa, yozib olaman."
		);
	});

	test("cover the knowledge lookup, which is the most frequent tool of all", () => {
		expect(buildToolAcknowledgement("uz", "search_knowledge_base")).toBe(
			"Bir daqiqa, tekshirib ko'raman."
		);
	});

	test("are absent for the tools that end or hand over the call", () => {
		expect(buildToolAcknowledgement("uz", "transfer_to_human")).toBeNull();
		expect(buildToolAcknowledgement("uz", "end_call")).toBeNull();
	});
});
