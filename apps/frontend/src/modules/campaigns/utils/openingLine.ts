/**
 * What the person hears in the first three seconds of a call they did not ask for.
 *
 * This is a PREVIEW. The line that is actually spoken is composed on the server
 * by `composeOutboundOpening` / `buildOutboundGreeting` in
 * `apps/backend/src/lib/ai/prompts.ts`, and the rules below are that function
 * transcribed - the identity sentence, the reason frame, the caps, the recording
 * notice and the handover question, in that order. The screen says «taxminiy»
 * next to it for the same reason `buildGreetingPreview` does on the AI yordamchi
 * page: the model may shift a word.
 *
 * It is worth duplicating because the purpose field is the heart of this feature
 * and it is impossible to write a good one blind. Somebody typing "qarzdorlik"
 * into a box labelled "why are we calling" has no way to know that what gets
 * said is "Sizga qarzdorlik bo'yicha qo'ng'iroq qildim." until they see it.
 *
 * The duplication was CHECKED, not assumed: composeOpeningLine().full was
 * compared against buildGreeting() for a named and an unnamed lead, a purpose
 * written as a phrase, one written as a sentence, and one over the 200-character
 * spoken cap - identical output in all five. If prompts.ts changes any of the
 * frames, the caps or the ordering, redo that comparison; a throwaway script
 * that imports both and diffs them takes two minutes to write.
 *
 * WHY AN OUTBOUND CALL NAMES THE BUSINESS AND AN INBOUND ONE DOES NOT. The agent's
 * inbound rules forbid asking or guessing which organisation is involved: the
 * caller dialled us, they already know who they reached, and asking makes the
 * platform sound lost. Outbound is the mirror image. The person's phone rang out
 * of nowhere; a voice that will not say who is calling is indistinguishable from
 * a scam call. So the first sentence names the business, says out loud that it is
 * a machine, and only then gives the reason.
 */

/** Languages the backend has an outbound opening for. Anything else falls back to Uzbek. */
export type PreviewLanguage = "uz" | "ru" | "en";

/** prompts.ts: MAX_PURPOSE_CHARS. */
const MAX_PURPOSE_CHARS = 600;
/** prompts.ts: MAX_SPOKEN_REASON_CHARS - longer than this is not a sentence. */
const MAX_SPOKEN_REASON_CHARS = 200;

const SENTENCE_END_PATTERN = /[.!?…]$/;
const FIRST_SENTENCE_PATTERN = /^[^.!?…]{1,200}[.!?…]/;

const IDENTITY: Record<PreviewLanguage, (business: string, name: string | null) => string> = {
	uz: (business, name) =>
		name === null
			? `Assalomu alaykum! Men «${business}» nomidan qo'ng'iroq qilyapman, raqamli yordamchiman.`
			: `Assalomu alaykum, ${name}! Men «${business}» nomidan qo'ng'iroq qilyapman, raqamli yordamchiman.`,
	ru: (business, name) =>
		name === null
			? `Здравствуйте! Я цифровой помощник, звоню от имени «${business}».`
			: `Здравствуйте, ${name}! Я цифровой помощник, звоню от имени «${business}».`,
	en: (business, name) =>
		name === null
			? `Hello! I am a digital assistant calling on behalf of "${business}".`
			: `Hello, ${name}! I am a digital assistant calling on behalf of "${business}".`,
};

const REASON_FRAMES: Record<PreviewLanguage, (reason: string) => string> = {
	uz: (reason) => `Sizga ${reason} bo'yicha qo'ng'iroq qildim.`,
	ru: (reason) => `Звоню по вопросу: ${reason}.`,
	en: (reason) => `I am calling about ${reason}.`,
};

const FLOOR_HANDOVER: Record<PreviewLanguage, string> = {
	uz: "Bir daqiqa vaqtingiz bo'ladimi?",
	ru: "У вас есть минута?",
	en: "Do you have a minute?",
};

export function toPreviewLanguage(code: string | null | undefined): PreviewLanguage {
	const normalised = (code ?? "").trim().slice(0, 2).toLowerCase();

	return normalised === "ru" || normalised === "en" ? normalised : "uz";
}

/** prompts.ts: readOwnerText - collapse the whitespace, cap the length, mark the cut. */
function readOwnerText(value: string | null | undefined, max: number): string | null {
	const text = (value ?? "").trim();

	if (text.length === 0) {
		return null;
	}

	const normalised = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");

	return normalised.length <= max ? normalised : `${normalised.slice(0, max).trimEnd()}…`;
}

/** prompts.ts: firstSpokenSentence - never cuts mid-word, because this is read out loud. */
function firstSpokenSentence(text: string): string {
	const match = FIRST_SENTENCE_PATTERN.exec(text);

	if (match !== null) {
		return match[0].trim();
	}

	if (text.length <= MAX_SPOKEN_REASON_CHARS) {
		return text;
	}

	const cut = text.slice(0, MAX_SPOKEN_REASON_CHARS);
	const lastSpace = cut.lastIndexOf(" ");

	return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}

/** prompts.ts: spokenReason - a phrase becomes a sentence, a sentence is left alone. */
export function spokenReason(purpose: string, language: PreviewLanguage): string | null {
	const text = readOwnerText(purpose, MAX_PURPOSE_CHARS);

	if (text === null) {
		return null;
	}

	const sentence = firstSpokenSentence(text.replace(/\n+/g, " ").trim());

	if (sentence.length === 0) {
		return null;
	}

	return SENTENCE_END_PATTERN.test(sentence) ? sentence : REASON_FRAMES[language](sentence);
}

export interface OpeningLineInput {
	/** The active (or campaign-specific) agent profile's business name. */
	businessName: string;
	/** The profile's recording notice; empty means the business cleared it. */
	recordingNotice?: string | null;
	language: PreviewLanguage;
	purpose: string;
	/**
	 * A name off the imported list, when previewing a specific lead. The form
	 * preview passes one so the owner can see that the call is addressed, not a
	 * robodial - the real call uses the CRM contact first and this second.
	 */
	leadName?: string | null;
}

/**
 * The opening line, as sentences, so the UI can show where each one comes from.
 *
 * Returned split rather than joined because the point of the preview is to make
 * the reason sentence - the only part the owner controls - visibly separate from
 * the identity sentence the platform always says.
 */
export function composeOpeningLine(input: OpeningLineInput): {
	identity: string;
	reason: string | null;
	notice: string | null;
	handover: string;
	full: string;
} {
	const business = input.businessName.trim().length > 0 ? input.businessName.trim() : "Biznes";
	const name = readOwnerText(input.leadName ?? null, 80);
	const identity = IDENTITY[input.language](business, name);
	const reason = spokenReason(input.purpose, input.language);
	const notice = readOwnerText(input.recordingNotice ?? null, 300);

	// Same guard as buildOutboundGreeting: a notice the owner already worked into
	// their own wording must not be read out twice.
	const parts = [identity, reason].filter((part): part is string => part !== null);
	const noticeSaid =
		notice !== null && parts.some((part) => part.toLowerCase().includes(notice.toLowerCase()));
	const spokenNotice = notice !== null && !noticeSaid ? notice : null;
	const handover = FLOOR_HANDOVER[input.language];

	return {
		identity,
		reason,
		notice: spokenNotice,
		handover,
		full: [...parts, spokenNotice, handover]
			.filter((part): part is string => part !== null && part.trim().length > 0)
			.join(" "),
	};
}
