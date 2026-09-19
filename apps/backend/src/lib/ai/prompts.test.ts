import { describe, expect, test } from "bun:test";
import type { ActiveAgentProfile, KnowledgeHit } from "@/lib/ai-agent";
import { AI_DIALECTS } from "@/lib/settings";
import type { VoiceSessionContext } from "@/lib/telephony/contracts";
import {
	AGENT_DIALECTS,
	buildGreeting,
	buildKnowledgeMissGuidance,
	buildSystemInstructions,
	buildTranscriptionPrompt,
	resolveAgentDialect,
	unconfiguredAgentProfile,
} from "./prompts";

/**
 * What these tests actually protect.
 *
 * 1. No business string is hardcoded any more. The old build shipped one
 *    government hotline and five municipal categories in the prompt; a
 *    regression there is invisible in a diff and obvious to a customer.
 * 2. The agent may not invent business facts. That rule is the product: a price
 *    or an opening time made up on a recorded line is the owner's liability, so
 *    the prompt has to carry the ban, the knowledge block and the configured
 *    policy for a question it cannot answer.
 */

function buildProfile(overrides: Partial<ActiveAgentProfile> = {}): ActiveAgentProfile {
	return {
		...unconfiguredAgentProfile(),
		id: "8f1c9d2e-0000-4000-8000-000000000001",
		businessName: "Oq Tish Dental",
		industry: "dental clinic",
		businessDescription: "Toshkentdagi xususiy stomatologiya klinikasi.",
		language: "uz",
		additionalLanguages: ["ru"],
		voice: "verse",
		greeting: null,
		recordingNotice: "Suhbat sifat nazorati uchun yozib olinadi.",
		customInstructions: null,
		ticketCategories: ["Qabulga yozilish", "Narx savoli", "Shikoyat", "Boshqa"],
		unknownPolicy: "transfer",
		transferExtensions: ["201", "202"],
		isConfigured: true,
		...overrides,
	};
}

function buildContext(overrides: Partial<VoiceSessionContext> = {}): VoiceSessionContext {
	return {
		callId: "11111111-1111-4111-8111-111111111111",
		channelId: "PJSIP/test-0001",
		callerNumber: "+998901234567",
		language: "uz",
		contact: null,
		isReturningCaller: false,
		previousCallCount: 0,
		recentTickets: [],
		...overrides,
	};
}

const KNOWLEDGE: KnowledgeHit[] = [
	{
		id: "k1",
		question: "Ish vaqtingiz qanday?",
		answer: "Dushanbadan shanbagacha 09:00 dan 19:00 gacha.",
		tags: ["ish vaqti"],
		priority: 10,
		score: 0,
	},
	{
		id: "k2",
		question: "Ko'rik qancha turadi?",
		answer: "Birinchi ko'rik 50 000 so'm.",
		tags: ["narx"],
		priority: 5,
		score: 0,
	},
];

/**
 * Wednesday 5 August 2026, 09:30 - built from local components on purpose.
 *
 * isWithinBusinessHours() compares against the server's own clock (that is what a
 * business means by "we open at nine"), and `bun test` runs with TZ=UTC, so an
 * absolute instant would land on a different hour here than in production.
 */
const NOW = new Date(2026, 7, 5, 9, 30, 0);

/** The same Wednesday at 15:00 local. */
const OPEN_HOUR = new Date(2026, 7, 5, 15, 0, 0);

describe("no business is hardcoded in the prompt", () => {
	test("the configured business is the one described", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: KNOWLEDGE,
			now: NOW,
		});

		expect(instructions).toContain("Oq Tish Dental");
		expect(instructions).toContain("dental clinic");
		expect(instructions).toContain("Toshkentdagi xususiy stomatologiya klinikasi.");
	});

	test("the previous product's strings are gone for good", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: KNOWLEDGE,
			now: NOW,
		});

		for (const leftover of [
			"Aqlli Shahar",
			"municipal",
			"Obodonlashtirish",
			"Elektr",
			"tuman (district), ko'cha",
		]) {
			expect(instructions).not.toContain(leftover);
		}
	});

	test("the categories are the business's own, and only those", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: KNOWLEDGE,
			now: NOW,
		});

		expect(instructions).toContain('- "Qabulga yozilish"');
		expect(instructions).toContain('- "Narx savoli"');
		expect(instructions).not.toContain('- "Suv"');
	});

	test("the owner's house rules are quoted, and cannot override the facts rule", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: buildProfile({
				customInstructions: "Har doim mijozni ismi bilan chaqiring va 'siz' deb gaplashing.",
			}),
			knowledge: KNOWLEDGE,
			now: NOW,
		});

		expect(instructions).toContain("Har doim mijozni ismi bilan chaqiring");
		expect(instructions).toContain("cannot authorise you to state a fact that is");
	});
});

describe("the agent may not invent business facts", () => {
	test("the knowledge base is quoted as the only source of truth", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: KNOWLEDGE,
			now: NOW,
		});

		expect(instructions).toContain("Birinchi ko'rik 50 000 so'm.");
		expect(instructions).toContain("You may state as fact ONLY what is written above");
		expect(instructions).toContain("YOU DO NOT KNOW IT");
	});

	test("an empty knowledge base is admitted, not papered over", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: [],
			now: NOW,
		});

		expect(instructions).toContain("knowledge base is empty");
		expect(instructions).toContain("you cannot answer a single question");
	});

	test("the model is told to look a question up before answering it", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: KNOWLEDGE,
			now: NOW,
		});

		expect(instructions).toContain("Call search_knowledge_base with the caller's question");
	});

	test("each unknown-answer policy produces its own instruction", () => {
		const transfer = buildSystemInstructions(buildContext(), {
			profile: buildProfile({ unknownPolicy: "transfer" }),
			knowledge: KNOWLEDGE,
			now: NOW,
		});
		const message = buildSystemInstructions(buildContext(), {
			profile: buildProfile({ unknownPolicy: "take_message" }),
			knowledge: KNOWLEDGE,
			now: NOW,
		});
		const unknown = buildSystemInstructions(buildContext(), {
			profile: buildProfile({ unknownPolicy: "say_unknown" }),
			knowledge: KNOWLEDGE,
			now: NOW,
		});

		expect(transfer).toContain("hoziroq hamkasbimga ulayman");
		expect(message).toContain("Offer to write the question down for a colleague");
		expect(unknown).toContain("bu ma'lumot menda yo'q");
		expect(unknown).not.toContain("Offer to write the question down for a colleague");
	});

	test("the same policy reaches the model again as the tool result", () => {
		expect(buildKnowledgeMissGuidance(buildProfile({ unknownPolicy: "transfer" }))).toContain(
			"transfer_to_human"
		);
		expect(buildKnowledgeMissGuidance(buildProfile({ unknownPolicy: "take_message" }))).toContain(
			"create_ticket"
		);
		expect(buildKnowledgeMissGuidance(buildProfile({ unknownPolicy: "say_unknown" }))).toContain(
			"do not have that information"
		);

		for (const policy of ["transfer", "take_message", "say_unknown"] as const) {
			expect(buildKnowledgeMissGuidance(buildProfile({ unknownPolicy: policy }))).toContain(
				"do not guess"
			);
		}
	});

	test("an unconfigured deployment says so instead of playing a business", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: unconfiguredAgentProfile(),
			knowledge: [],
			now: NOW,
		});

		expect(instructions).toContain("nobody has configured this line yet");
		expect(instructions).toContain("xabaringizni yozib olib");
	});
});

describe("business hours", () => {
	const closedProfile = buildProfile({
		// The clinic works Wednesday afternoons only, so NOW (09:30) is shut.
		businessHours: { days: { wed: [["14:00", "18:00"]] } },
		afterHoursMessage: "Hozir klinika yopiq, ertaga soat to'qqizdan javob beramiz.",
	});

	test("the prompt gains a closed branch", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: closedProfile,
			knowledge: KNOWLEDGE,
			now: NOW,
		});

		expect(instructions).toContain("# THE BUSINESS IS CLOSED RIGHT NOW");
		expect(instructions).toContain("Hozir klinika yopiq");
	});

	test("an open hour keeps the closed branch out of the prompt", () => {
		const instructions = buildSystemInstructions(buildContext(), {
			profile: closedProfile,
			knowledge: KNOWLEDGE,
			now: OPEN_HOUR,
		});

		expect(instructions).not.toContain("# THE BUSINESS IS CLOSED RIGHT NOW");
	});

	test("the caller hears the owner's after-hours line in the greeting", () => {
		expect(buildGreeting(buildContext(), closedProfile, NOW)).toContain("Hozir klinika yopiq");
	});
});

describe("greeting", () => {
	test("the business's own greeting is used verbatim", () => {
		const greeting = buildGreeting(
			buildContext(),
			buildProfile({ greeting: "Oq Tish Dental, xush kelibsiz! Nima bo'ldi?" }),
			NOW
		);

		expect(greeting).toBe(
			"Oq Tish Dental, xush kelibsiz! Nima bo'ldi? Suhbat sifat nazorati uchun yozib olinadi."
		);
	});

	test("a business with no greeting gets a short one built from its name", () => {
		const greeting = buildGreeting(buildContext(), buildProfile(), NOW);

		expect(greeting).toContain("Oq Tish Dental");
		expect(greeting).toContain("Assalomu alaykum");
		expect(greeting).toContain("Sizga qanday yordam bera olaman?");
	});

	test("a known caller is greeted by name", () => {
		const greeting = buildGreeting(
			buildContext({
				contact: { id: "c1", firstName: "Anvar", lastName: "Karimov", address: null },
			}),
			buildProfile(),
			NOW
		);

		expect(greeting).toContain("Anvar Karimov");
	});

	test("Russian is spoken because the profile serves it, not because of a hardcoded check", () => {
		const russianCaller = buildContext({ language: "ru-RU" });

		expect(buildGreeting(russianCaller, buildProfile(), NOW)).toContain("Здравствуйте");
		// The same call to a business that only serves Uzbek stays Uzbek.
		expect(buildGreeting(russianCaller, buildProfile({ additionalLanguages: [] }), NOW)).toContain(
			"Assalomu alaykum"
		);
	});

	test("the recording notice is said once, even when the owner wrote it into the greeting", () => {
		const greeting = buildGreeting(
			buildContext(),
			buildProfile({
				greeting: "Assalomu alaykum! Suhbat sifat nazorati uchun yozib olinadi.",
			}),
			NOW
		);

		expect(greeting.match(/yozib olinadi/g)).toHaveLength(1);
	});

	test("a business with no recording notice is not given one", () => {
		const greeting = buildGreeting(buildContext(), buildProfile({ recordingNotice: null }), NOW);

		expect(greeting).not.toContain("yozib olinadi");
	});
});

/**
 * The decoding hint for speech-to-text.
 *
 * This exists because no transcription model accepts `language: "uz"` - verified
 * against the live GA endpoint for whisper-1, gpt-4o-transcribe and
 * gpt-4o-mini-transcribe alike. Left to guess on 8 kHz telephony audio the
 * transcriber returned Greek, Welsh and Kazakh text for Uzbek speech. Measured on
 * a real 39-second call recording whose text is known: whisper-1 with no hint
 * matched 0 of 18 words, gpt-4o-transcribe with this hint matched 16 of 18.
 */
describe("transcription decoding hint", () => {
	test("names the language in several forms so the decoder cannot drift", () => {
		const prompt = buildTranscriptionPrompt(buildProfile(), KNOWLEDGE);

		expect(prompt).not.toBeNull();
		expect(prompt).toContain("o'zbek");
		expect(prompt?.toLowerCase()).toContain("uzbek");
	});

	test("says dialect is expected, because callers ring from every region", () => {
		const prompt = buildTranscriptionPrompt(buildProfile(), KNOWLEDGE);

		expect(prompt).toContain("sheva");
	});

	test("carries the business's own nouns, which are what a guessing decoder mangles", () => {
		const prompt = buildTranscriptionPrompt(buildProfile(), KNOWLEDGE);

		expect(prompt).toContain("Oq Tish Dental");
		expect(prompt).toContain("Ish vaqtingiz qanday?");
		expect(prompt).toContain("Ko'rik qancha turadi?");
	});

	test("works with no knowledge base at all", () => {
		const prompt = buildTranscriptionPrompt(buildProfile(), []);

		expect(prompt).not.toBeNull();
		expect(prompt).toContain("o'zbek");
	});

	test("switches with the business language", () => {
		const russian = buildTranscriptionPrompt(buildProfile({ language: "ru" }), []);

		expect(russian).toContain("русском");
		expect(russian).not.toContain("o'zbek tilida.");
	});

	test("stays a bias, not an essay", () => {
		const many: KnowledgeHit[] = Array.from({ length: 40 }, (_, i) => ({
			id: `k${i}`,
			question: `Juda uzun savol raqami ${i} va yana ko'p so'zlar bilan davom etadigan matn`,
			answer: "javob",
			tags: [],
			priority: 0,
			score: 0,
		}));

		const prompt = buildTranscriptionPrompt(buildProfile(), many);

		// A hint the length of a transcript stops biasing and starts competing with
		// the audio - which is how a near-silent turn comes back as the hint itself.
		expect((prompt ?? "").length).toBeLessThanOrEqual(901);
	});

	test("a regional subtag still resolves to the language's hint", () => {
		const prompt = buildTranscriptionPrompt(buildProfile({ language: "uz-UZ" }), []);

		expect(prompt).toContain("o'zbek");
	});
});

describe("dialect (sheva) is understood, never spoken", () => {
	/**
	 * The regression these tests exist for.
	 *
	 * A previous change read "u ai shevada gapira olishi kerak" as a request for
	 * the agent to PRODUCE dialect, and shipped a prompt block that told it to say
	 * "hovva" and "kelvotti". The owner's correction was that it must understand
	 * people who talk that way and answer in clean standard Uzbek. So the same word
	 * lists survive, and the only thing that matters here is the direction they
	 * point in: caller's word on the left, standard meaning on the right, and no
	 * sentence anywhere that tells the agent to say one.
	 */
	const PRODUCTION_PHRASES = [
		"Answer in it",
		"Answer in it the",
		"Callers on this line speak",
		"Use only forms you are sure a local really says",
		"is how a person speaks, not every word in it",
		"the way people do here",
	];

	test("the comprehension block is on every call, whatever the setting says", () => {
		// Understanding a Khorezm caller costs a Tashkent line nothing, and a line
		// that cannot follow one is the failure this deployment was bought to avoid.
		for (const option of [...AGENT_DIALECTS, { id: "klingon" }]) {
			const instructions = buildSystemInstructions(buildContext(), {
				profile: buildProfile(),
				dialect: option.id,
			});

			expect(instructions).toContain("# UNDERSTANDING A CALLER WHO SPEAKS IN SHEVA");
			expect(instructions).toContain("hovva");
			expect(instructions).toContain("kelvotti");
			expect(instructions).toContain("opke");
			expect(instructions).toContain("kelibman");
		}
	});

	test("every form is given as a translation into standard Uzbek, not as a phrase to use", () => {
		const instructions = buildSystemInstructions(buildContext(), { profile: buildProfile() });

		// The arrow is the whole feature: "kelvotti" alone is vocabulary, and a model
		// handed vocabulary uses it.
		expect(instructions).toContain('"kelvotti" / "kelotti" = kelayapti');
		expect(instructions).toContain('"hovva" / "howa" = ha');
		expect(instructions).toContain('"opke" = olib kel');
		expect(instructions).toContain('"kelibman" = keldim');
		expect(instructions).toContain("It tells you what their words MEAN; it is not how you talk");
	});

	test("no prompt text anywhere tells the agent to produce a dialect form", () => {
		for (const option of AGENT_DIALECTS) {
			const instructions = buildSystemInstructions(buildContext(), {
				profile: buildProfile(),
				dialect: option.id,
			});

			expect(instructions).toContain("reply in clean, well-formed standard Uzbek");
			expect(instructions).toContain("NEVER repeat a dialect");
			expect(instructions).toContain("never imitate their accent");

			for (const phrase of PRODUCTION_PHRASES) {
				expect(instructions).not.toContain(phrase);
			}
		}
	});

	test("choosing a region only adds an emphasis line - it never removes coverage", () => {
		const now = new Date("2026-02-01T09:00:00.000Z");
		const neutral = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: KNOWLEDGE,
			dialect: "neutral",
			now,
		});
		const xorazm = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: KNOWLEDGE,
			dialect: "xorazm",
			now,
		});

		expect(neutral).not.toContain("Most callers on this number are from");
		expect(xorazm).toContain("Most callers on this number are from Xorazm - Urganch and Xiva");

		// Everything the neutral prompt knows, the emphasised one still knows: the
		// emphasis is one added sentence, not a narrowing of the glossary.
		expect(xorazm.length).toBeGreaterThan(neutral.length);
		for (const word of ["opke", "kelibman", "qalesiz", "kelvotti"]) {
			expect(neutral).toContain(word);
			expect(xorazm).toContain(word);
		}
	});

	test("no dialect defaults, and an unset setting still understands everyone", () => {
		const now = new Date("2026-02-01T09:00:00.000Z");
		const unset = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: KNOWLEDGE,
			now,
		});
		const explicitlyNeutral = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			knowledge: KNOWLEDGE,
			dialect: "neutral",
			now,
		});

		// Both prompts need the SAME `now`: the caller-context block prints it to the
		// millisecond, so two builds that straddle a tick differ by one digit and the
		// equality below fails at random rather than on a real change.
		expect(explicitlyNeutral).toBe(unset);
		expect(unset).toContain("# UNDERSTANDING A CALLER WHO SPEAKS IN SHEVA");
	});

	test("every offered choice is labelled and described as comprehension", () => {
		for (const option of AGENT_DIALECTS) {
			// The owner reads these two strings on the AI yordamchi page and nothing
			// else, so a label that still promises dialect SPEECH is the bug shipping
			// again with the prompt fixed underneath it.
			expect(option.label.length).toBeGreaterThan(0);
			expect(option.description).toContain("tushun");

			if (option.id === "neutral") {
				continue;
			}

			expect(option.label).toContain("eshitiladi");
			expect(option.description).toContain("adabiy tilda javob beradi");
		}
	});

	test("a value nobody registered falls back to neutral instead of throwing", () => {
		expect(resolveAgentDialect(undefined)).toBe("neutral");
		expect(resolveAgentDialect("")).toBe("neutral");
		expect(resolveAgentDialect("   ")).toBe("neutral");
		expect(resolveAgentDialect("klingon")).toBe("neutral");
	});

	test("both the Uzbek and the English spelling of a region resolve", () => {
		// The value is typed by a person, or written by whichever UI got there
		// first, so "Khorezm" and "xorazm" must not be two different settings.
		expect(resolveAgentDialect("Khorezm")).toBe("xorazm");
		expect(resolveAgentDialect("URGANCH")).toBe("xorazm");
		expect(resolveAgentDialect("Tashkent")).toBe("toshkent");
		expect(resolveAgentDialect("fergana")).toBe("fargona");
		expect(resolveAgentDialect("farg'ona")).toBe("fargona");
		expect(resolveAgentDialect("samarkand-bukhara")).toBe("samarqand-buxoro");
		expect(resolveAgentDialect("samarqand buxoro")).toBe("samarqand-buxoro");
	});

	test("every id the dropdown offers resolves to itself", () => {
		for (const option of AGENT_DIALECTS) {
			expect(resolveAgentDialect(option.id)).toBe(option.id);
		}
	});
});

describe("delivery on the line", () => {
	test("the model is told about pace, pauses and taking its turn", () => {
		const instructions = buildSystemInstructions(buildContext(), { profile: buildProfile() });

		// Word choice was already covered; how it lands in the ear was not, and it
		// is the first thing a caller notices.
		expect(instructions).toContain("Pace:");
		expect(instructions).toContain("Pause where a person would");
		expect(instructions).toContain("come back straight away");
	});

	test("beautiful and natural are one instruction, not two contradicting ones", () => {
		const instructions = buildSystemInstructions(buildContext(), { profile: buildProfile() });

		// The block used to say "use everyday spoken forms, not written-Uzbek
		// formality" while the owner was asking for "chiroyli". Both survive only if
		// the same paragraph says which everyday forms are welcome and which are not.
		expect(instructions).toContain("Speak beautifully");
		expect(instructions).toContain("clean, well-formed standard Uzbek");
		expect(instructions).toContain("Sheva forms and slang are not");
		expect(instructions).toContain("no officialese");
		expect(instructions).not.toContain("not written-Uzbek formality");
	});
});

describe("emotion", () => {
	test("the model is told to read the feeling before it chooses a reply", () => {
		const instructions = buildSystemInstructions(buildContext(), { profile: buildProfile() });

		expect(instructions).toContain("# WHAT THE CALLER IS FEELING");
		expect(instructions).toContain("put one word on it");

		// The owner asked for all of them, so all of them are named. A block that
		// only handles anger is the one every voice agent already ships.
		for (const feeling of [
			"Angry",
			"Worried or frightened",
			"Confused",
			"Grieving",
			"Impatient",
			"Pleased or joking",
			"Embarrassed",
			"Suspicious",
			"Exhausted",
		]) {
			expect(instructions).toContain(feeling);
		}
	});

	test("its own delivery has to carry the feeling, in physical terms", () => {
		const instructions = buildSystemInstructions(buildContext(), { profile: buildProfile() });

		// "Show empathy" produces a script. "Slower, softer" produces a voice.
		expect(instructions).toContain("Your voice carries the feeling");
		expect(instructions).toContain("Warmth is a slower, softer delivery");
	});

	test("the four ways warmth turns unpleasant are named", () => {
		const instructions = buildSystemInstructions(buildContext(), { profile: buildProfile() });

		expect(instructions).toContain("Performed sympathy");
		expect(instructions).toContain("Apologising in a loop");
		expect(instructions).toContain("Brightness aimed at somebody who is upset");
		expect(instructions).toContain("Catching their anger");
	});
});

describe("the dialect list the dashboard offers", () => {
	test("every registered dialect resolves to a region the prompt builder knows", () => {
		// The registry is where the dropdown's values come from and this file is
		// where they turn into instructions, so a value added there and not here
		// would save happily and change nothing - a dead control, which is the whole
		// defect this category exists to remove.
		for (const dialect of AI_DIALECTS) {
			const resolved = resolveAgentDialect(dialect);
			const instructions = buildSystemInstructions(buildContext(), {
				profile: buildProfile(),
				dialect,
			});

			// Comprehension is unconditional; only the emphasis line is not.
			expect(instructions).toContain("# UNDERSTANDING A CALLER WHO SPEAKS IN SHEVA");
			expect(AGENT_DIALECTS.map((option) => option.id)).toContain(resolved);

			if (dialect === "neutral") {
				expect(resolved).toBe("neutral");
				expect(instructions).not.toContain("Most callers on this number are from");
				continue;
			}

			expect(resolved).not.toBe("neutral");
			expect(instructions).toContain("Most callers on this number are from");
		}
	});
});

describe("the company-name rule follows the direction of the call", () => {
	/** The one sentence that makes an unsolicited call legitimate. */
	const CAMPAIGN = {
		purpose: "Qarzingiz haqida eslatish uchun",
		kind: "reminder",
		script: null,
		variables: {},
	};

	const INBOUND_RULE = "Do not restate the company name mid-call";

	test("an inbound caller is not told the company name twice", () => {
		// They dialled us. Repeating who they reached sounds like a recording.
		const instructions = buildSystemInstructions(buildContext(), {
			profile: unconfiguredAgentProfile(),
			knowledge: [],
		});

		expect(instructions).toContain(INBOUND_RULE);
	});

	test("an outbound call never carries the inbound rule", () => {
		// The regression this guards: HOW YOU SPEAK was a plain constant on every
		// call, so an outbound prompt said "stop restating the company name" AND
		// "name the business every time they ask" - and which one won was left to
		// recency. The person did not dial us; refusing to say who is calling is the
		// behaviour of a scam, not of a business.
		const instructions = buildSystemInstructions(buildContext({ campaign: CAMPAIGN } as never), {
			profile: unconfiguredAgentProfile(),
			knowledge: [],
		});

		expect(instructions).not.toContain(INBOUND_RULE);
		expect(instructions.replace(/\s+/g, " ")).toContain(
			"with the name of the business, EVERY time they ask"
		);
	});
});
