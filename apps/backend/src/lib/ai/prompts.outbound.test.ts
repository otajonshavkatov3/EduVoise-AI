/**
 * The half of the prompt that exists only because the person did not dial us.
 *
 * Kept in its own file rather than appended to prompts.test.ts because it
 * protects a different property. That file asserts that no business string is
 * hardcoded; this one asserts the rules that decide whether an unsolicited call
 * is professional or a nuisance - and every assertion below is a rule somebody
 * would otherwise quietly "simplify" away:
 *
 *   identity   the business is named in the FIRST sentence and named again
 *              whenever it is asked. That is the exact INVERSE of the inbound
 *              rule, so a refactor that unified the two would break this feature
 *              in precisely the way that gets a number blocked by a carrier.
 *   consent    the opening line asks for the person's time instead of asking
 *              what they want.
 *   refusal    "never call me again" routes to opt_out, and outranks the purpose
 *              of the campaign.
 *   isolation  none of it appears on an inbound call.
 */
import { describe, expect, test } from "bun:test";
import type { ActiveAgentProfile } from "@/lib/ai-agent";
import type { OutboundCallPurpose, VoiceSessionContext } from "@/lib/telephony/contracts";
import { buildGreeting, buildSystemInstructions, unconfiguredAgentProfile } from "./prompts";

function buildProfile(overrides: Partial<ActiveAgentProfile> = {}): ActiveAgentProfile {
	return {
		...unconfiguredAgentProfile(),
		id: "8f1c9d2e-0000-4000-8000-000000000001",
		businessName: "Oq Tish Dental",
		industry: "dental clinic",
		businessDescription: "Toshkentdagi xususiy stomatologiya klinikasi.",
		language: "uz",
		voice: "verse",
		greeting: null,
		recordingNotice: "Suhbat sifat nazorati uchun yozib olinadi.",
		ticketCategories: ["Qabulga yozilish", "Narx savoli", "Boshqa"],
		isConfigured: true,
		...overrides,
	};
}

function buildCampaign(overrides: Partial<OutboundCallPurpose> = {}): OutboundCallPurpose {
	return {
		kind: "reminder",
		campaignName: "Avgust eslatmalari",
		purpose: "profilaktik ko'rikka yozilishni eslatish",
		openingLine: null,
		script: null,
		leadName: null,
		variables: {},
		notes: null,
		...overrides,
	};
}

function buildContext(overrides: Partial<VoiceSessionContext> = {}): VoiceSessionContext {
	return {
		callId: "11111111-1111-4111-8111-111111111111",
		channelId: "PJSIP/test-0001",
		callerNumber: "998901234567",
		language: "uz",
		contact: null,
		isReturningCaller: false,
		previousCallCount: 0,
		recentTickets: [],
		...overrides,
	};
}

/** Wednesday 5 August 2026, 09:30 local - inside any plausible business day. */
const NOW = new Date(2026, 7, 5, 9, 30, 0);

// ===========================================
// The opening line
// ===========================================

describe("buildGreeting on an outbound call", () => {
	test("names the business, admits it is a machine, gives the reason, asks for a minute", () => {
		const greeting = buildGreeting(
			buildContext({ campaign: buildCampaign() }),
			buildProfile(),
			NOW
		);

		// Their phone rang with a number they do not know. All four facts belong in
		// the first breath, and in this order.
		expect(greeting).toContain("Oq Tish Dental");
		expect(greeting).toContain("raqamli yordamchiman");
		expect(greeting).toContain("profilaktik ko'rikka yozilishni eslatish");
		expect(greeting).toContain("Bir daqiqa vaqtingiz bo'ladimi?");

		// "How can I help you" is an inbound question: they did not call us.
		expect(greeting).not.toContain("Sizga qanday yordam bera olaman?");
	});

	test("ignores the business's inbound greeting, which was written for callers", () => {
		const greeting = buildGreeting(
			buildContext({ campaign: buildCampaign() }),
			buildProfile({ greeting: "Qo'ng'iroq qilganingiz uchun rahmat!" }),
			NOW
		);

		// Thanking somebody for calling, when we rang them, is nonsense at best.
		expect(greeting).not.toContain("Qo'ng'iroq qilganingiz uchun rahmat!");
		expect(greeting).toContain("Oq Tish Dental");
	});

	test("puts the identity sentence in front of an opening line that hides who is calling", () => {
		const written = "Sizga maxsus taklifimiz bor!";
		const greeting = buildGreeting(
			buildContext({ campaign: buildCampaign({ openingLine: written }) }),
			buildProfile(),
			NOW
		);

		// The owner's wording is kept, but an unidentified outbound call is
		// indistinguishable from a scam call, and that is not a choice a campaign gets
		// to make.
		expect(greeting).toContain(written);
		expect(greeting).toContain("Oq Tish Dental");
		expect(greeting.indexOf("Oq Tish Dental")).toBeLessThan(greeting.indexOf(written));
	});

	test("leaves an opening line that already names the business alone", () => {
		const written = "Assalomu alaykum, Oq Tish Dental sizni bezovta qilyapti.";
		const greeting = buildGreeting(
			buildContext({ campaign: buildCampaign({ openingLine: written }) }),
			buildProfile(),
			NOW
		);

		// No second introduction bolted in front saying the same thing twice.
		expect(greeting.startsWith(written)).toBe(true);
	});

	test("greets a known contact by name in preference to the imported list", () => {
		const greeting = buildGreeting(
			buildContext({
				campaign: buildCampaign({ leadName: "Ro'yxatdagi Ism" }),
				contact: { id: "c1", firstName: "Anvar", lastName: null, address: null },
			}),
			buildProfile(),
			NOW
		);

		// A contacts row is a name the business has already used and corrected; the
		// spreadsheet column is whatever somebody typed into it.
		expect(greeting).toContain("Anvar");
		expect(greeting).not.toContain("Ro'yxatdagi Ism");
	});

	test("falls back to the list name for a lead with no contact row yet", () => {
		const greeting = buildGreeting(
			buildContext({ campaign: buildCampaign({ leadName: "Anvar" }) }),
			buildProfile(),
			NOW
		);

		expect(greeting).toContain("Anvar");
	});

	test("never says the business is closed on a call the business itself placed", () => {
		// On an inbound call at 03:00 this line is correct and required. From the
		// party who dialled it is nonsense - and a campaign ringing at 03:00 is a
		// broken calling window, which the greeting must not paper over.
		const greeting = buildGreeting(
			buildContext({ campaign: buildCampaign() }),
			buildProfile({
				businessHours: { mon: "09:00-18:00", tue: "09:00-18:00", wed: "09:00-18:00" },
			}),
			new Date(2026, 7, 5, 3, 0, 0)
		);

		expect(greeting).not.toContain("Hozir ish vaqtimiz tugagan");
	});

	test("still carries the recording notice", () => {
		const greeting = buildGreeting(
			buildContext({ campaign: buildCampaign() }),
			buildProfile(),
			NOW
		);

		expect(greeting).toContain("Suhbat sifat nazorati uchun yozib olinadi.");
	});
});

// ===========================================
// The instructions
// ===========================================

describe("buildSystemInstructions on an outbound call", () => {
	function instructionsFor(campaign: OutboundCallPurpose, profile = buildProfile()): string {
		return buildSystemInstructions(buildContext({ campaign }), { profile, now: NOW });
	}

	test("adds the outbound section and advertises the outcome tool", () => {
		const instructions = instructionsFor(buildCampaign());

		expect(instructions).toContain("# THIS IS AN OUTBOUND CALL - YOU RANG THEM");
		expect(instructions).toContain("WHY THE BUSINESS IS CALLING");
		expect(instructions).toContain("record_call_outcome");
	});

	test("re-states the role: on this call the agent is the one who rang", () => {
		expect(instructionsFor(buildCampaign())).toContain("on this call you are the");
		expect(instructionsFor(buildCampaign())).not.toContain(
			"You are the voice receptionist answering the telephone"
		);
	});

	test("quotes the opening line the platform actually spoke", () => {
		const context = buildContext({ campaign: buildCampaign() });
		const profile = buildProfile();
		const greeting = buildGreeting(context, profile, NOW);
		const instructions = buildSystemInstructions(context, { profile, now: NOW });
		const identity = "Men «Oq Tish Dental» nomidan qo'ng'iroq qilyapman";

		// The agent has to know exactly what the person was already told, or its
		// second turn repeats the introduction - which is what exposes a bot.
		expect(greeting).toContain(identity);
		expect(instructions).toContain(identity);
	});

	test("inverts the inbound rule: the business is renamed every time it is asked", () => {
		const instructions = instructionsFor(buildCampaign());

		expect(instructions).toContain("EVERY time they ask, however many times that is");
		expect(instructions).toContain("Never claim to be a person");
	});

	test("routes every wording of 'stop calling me' to opt_out, immediately", () => {
		const instructions = instructionsFor(buildCampaign());

		expect(instructions).toContain("THE MOMENT THEY SAY NO, THE CALL IS OVER");
		expect(instructions).toContain('outcome "opt_out" straight away');
		// A plain refusal is NOT an opt-out. They are different instructions, and a
		// business that treats them the same is why people stop answering the phone.
		expect(instructions).toContain('outcome "refused"');
	});

	test("handles wrong person, voicemail and call-me-later distinctly", () => {
		const instructions = instructionsFor(buildCampaign());

		expect(instructions).toContain("WRONG PERSON");
		expect(instructions).toContain("A MACHINE ANSWERED");
		expect(instructions).toContain("CALL ME LATER");
	});

	test("gives a sales campaign different rules from a reminder", () => {
		expect(instructionsFor(buildCampaign({ kind: "sales" }))).toContain(
			"You are selling something and you must say so plainly"
		);
		expect(instructionsFor(buildCampaign({ kind: "reminder" }))).not.toContain(
			"You are selling something and you must say so plainly"
		);
	});

	test("makes an advertising call offer the way out in the same breath", () => {
		expect(instructionsFor(buildCampaign({ kind: "advertising" }))).toContain(
			"This is an advertising call"
		);
	});

	test("refuses to invent a reason when the campaign gave none", () => {
		// An agent that improvises a reason for an unsolicited call is the worst
		// failure this whole feature has.
		expect(instructionsFor(buildCampaign({ purpose: "   " }))).toContain("Do not invent one");
	});

	test("quotes the per-lead variables and warns that they may be wrong", () => {
		const instructions = instructionsFor(
			buildCampaign({
				variables: { Buyurtma: "AB-12", Summa: "250 000" },
				notes: "Oldingi safar javob bermagan",
			})
		);

		expect(instructions).toContain("Buyurtma: AB-12");
		expect(instructions).toContain("Summa: 250 000");
		expect(instructions).toContain("Oldingi safar javob bermagan");
		expect(instructions).toContain("do not argue");
	});

	test("caps a pasted essay of lead variables instead of sending all of it", () => {
		const variables: Record<string, string> = {};

		for (let i = 0; i < 40; i++) {
			variables[`Ustun${i}`] = `Qiymat ${i}`;
		}

		const instructions = instructionsFor(buildCampaign({ variables }));
		const quoted = [...instructions.matchAll(/\* Ustun\d+:/g)];

		// MAX_LEAD_VARIABLES in prompts.ts. Owner data arrives from a spreadsheet, so
		// the prompt cannot grow with whatever the import happened to contain.
		expect(quoted.length).toBe(12);
	});

	test("changes nothing at all on an inbound call", () => {
		// The regression that matters most. Every existing caller must get the prompt
		// they got before campaigns existed.
		const instructions = buildSystemInstructions(buildContext(), {
			profile: buildProfile(),
			now: NOW,
		});

		expect(instructions).not.toContain("# THIS IS AN OUTBOUND CALL - YOU RANG THEM");
		expect(instructions).not.toContain("record_call_outcome");
		expect(instructions).toContain("You are the voice receptionist answering the telephone");
	});
});
