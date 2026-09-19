// biome-ignore-all lint/style/useNamingConvention: REJECT_MESSAGES is keyed by PhoneRejectReason, whose values are the codes the HTTP layer returns and the UI groups by. They are snake_case because that is what they are on the wire, and renaming the keys to camelCase would split one vocabulary into two.

/**
 * One stored form for a phone number, and one function that produces it.
 *
 * WHY THIS EXISTS AT ALL
 *
 * This database already holds four spellings of the same field: "201",
 * "anonymous", "905706507" and "998905706507". Two of those are the same person's
 * mobile written differently, one is an internal extension, and one is what
 * Asterisk sends when the caller withheld their number. A campaign cannot work
 * with that: "have I already got this lead?", "is this number on the do-not-call
 * list?" and "which contact is this?" are all equality checks, and equality on
 * un-normalised text answers all three wrongly.
 *
 * THE DECISION
 *
 * Digits only. No "+", no spaces, no brackets. Country code included.
 *
 *     "+998 90 570 65 07"  -> "998905706507"
 *     "90 570 65 07"       -> "998905706507"   (bare national number)
 *     "8 90 570 65 07"     -> "998905706507"   (old trunk-prefix habit)
 *     "00998905706507"     -> "998905706507"   (international access code)
 *     "201"                -> "201"            (internal PJSIP extension)
 *     "anonymous"          -> rejected
 *
 * Three reasons for that form rather than "+998...":
 *
 *   1. It is what `contacts.phone_number` already holds for every seeded row and
 *      what Asterisk reports on `calls.caller_number`, so a lead matches a contact
 *      and a call with `=` and the existing unique index on contacts is usable.
 *   2. It drops straight into a dial string with no editing step - which matters
 *      because the dial string is built from configuration, and a stored "+" would
 *      have to be stripped by whoever builds it, in a place easy to forget.
 *   3. varchar(20) holds it with room to spare; E.164 is at most 15 digits.
 *
 * EXTENSIONS ARE FIRST-CLASS, NOT A SPECIAL CASE TO TOLERATE
 *
 * `SIP_TRUNK_HOST` is empty in this deployment, so today the platform can only
 * dial internal PJSIP endpoints (101-104 desk, 201-204 browser). A campaign aimed
 * at a mobile number will fail on every row until a trunk is bought and
 * configured. Accepting a three-digit extension is therefore the only way to test
 * the whole feature end to end before that happens, so `kind` reports which of
 * the two a number is and callers branch on it rather than guessing from length.
 */

/** The default country code applied to a bare national number. */
const UZ_COUNTRY_CODE = "998";

/** Uzbek national significant number: 9 digits, e.g. 905706507. */
const UZ_NATIONAL_LENGTH = 9;

/** E.164 allows at most 15 digits including the country code. */
const MAX_E164_DIGITS = 15;

/** Internal PJSIP extensions in this deployment are three digits (101-104, 201-204, 900). */
const EXTENSION_LENGTH = 3;

export type PhoneKind = "msisdn" | "extension";

export type PhoneRejectReason =
	| "empty"
	| "not_a_number"
	| "too_short"
	| "too_long"
	| "leading_zero";

export type NormalisedPhone =
	| { ok: true; phone: string; kind: PhoneKind }
	| { ok: false; reason: PhoneRejectReason; message: string };

/** Why a number was rejected, in the language the import result is shown in. */
const REJECT_MESSAGES: Record<PhoneRejectReason, string> = {
	empty: "Raqam yozilmagan",
	not_a_number:
		"Raqamda faqat sonlar bo'lishi kerak (masalan 998905706507, 90 570 65 07 yoki ichki raqam 201)",
	too_short: "Raqam juda qisqa — to'liq raqamni yozing (masalan 998905706507)",
	too_long: "Raqam juda uzun — xalqaro raqamda 15 tadan ko'p son bo'lmaydi",
	leading_zero: "Raqam 0 bilan boshlanmasligi kerak — davlat kodi bilan yozing (998...)",
};

function reject(reason: PhoneRejectReason): NormalisedPhone {
	return { ok: false, reason, message: REJECT_MESSAGES[reason] };
}

/**
 * Turn whatever a human pasted into the stored form, or say precisely why not.
 *
 * Never throws and never guesses: an unrecognisable value comes back as a reason
 * the import can print next to the offending row, because "12 raqam import
 * qilinmadi" without saying which is not a usable error message.
 */
export function normalisePhone(input: string): NormalisedPhone {
	const trimmed = input.trim();

	if (trimmed.length === 0) {
		return reject("empty");
	}

	// Letters are the "anonymous" case and every misplaced spreadsheet column.
	// Checked before stripping, because stripping would silently turn "anonymous
	// 998901112233" into a valid number and dial a row nobody vetted.
	if (/[A-Za-z]/.test(trimmed)) {
		return reject("not_a_number");
	}

	// Separators a human or a spreadsheet adds: spaces, dashes, dots, brackets, and
	// a leading plus. Anything else left over is not a phone number.
	const stripped = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");

	if (!/^\d+$/.test(stripped)) {
		return reject("not_a_number");
	}

	let digits = stripped;

	// "00" is the international access code, "810" and a bare leading "8" are the
	// old Soviet-era trunk prefix habit still common on hand-written lists.
	if (digits.startsWith("00")) {
		digits = digits.slice(2);
	} else if (digits.length === UZ_NATIONAL_LENGTH + 1 && digits.startsWith("8")) {
		digits = digits.slice(1);
	}

	if (digits.length === EXTENSION_LENGTH) {
		// An internal extension. Kept verbatim - it is not an MSISDN and prefixing it
		// with a country code would dial a stranger.
		return { ok: true, phone: digits, kind: "extension" };
	}

	if (digits.length === UZ_NATIONAL_LENGTH) {
		return { ok: true, phone: `${UZ_COUNTRY_CODE}${digits}`, kind: "msisdn" };
	}

	if (digits.length < UZ_NATIONAL_LENGTH) {
		return reject("too_short");
	}

	if (digits.length > MAX_E164_DIGITS) {
		return reject("too_long");
	}

	// A country code never starts with 0, so a leading zero here means the row is a
	// national number with a trunk prefix we do not recognise. Rejected rather than
	// guessed at: guessing wrong dials somebody else.
	if (digits.startsWith("0")) {
		return reject("leading_zero");
	}

	return { ok: true, phone: digits, kind: "msisdn" };
}

/**
 * Is this stored number an internal extension rather than a real subscriber?
 *
 * The one caller that matters is the start-a-campaign check: without a SIP trunk
 * only extensions can be reached, so a campaign whose leads are all MSISDNs must
 * be refused instead of failing on every row.
 */
export function isExtension(storedPhone: string): boolean {
	return storedPhone.length === EXTENSION_LENGTH && /^\d+$/.test(storedPhone);
}

/** Group digits for display: 998905706507 -> "+998 90 570 65 07". Extensions unchanged. */
export function formatPhone(storedPhone: string): string {
	if (isExtension(storedPhone)) {
		return storedPhone;
	}

	if (storedPhone.length === UZ_COUNTRY_CODE.length + UZ_NATIONAL_LENGTH) {
		const cc = storedPhone.slice(0, 3);
		const operator = storedPhone.slice(3, 5);
		const first = storedPhone.slice(5, 8);
		const second = storedPhone.slice(8, 10);
		const third = storedPhone.slice(10, 12);

		return `+${cc} ${operator} ${first} ${second} ${third}`;
	}

	return `+${storedPhone}`;
}
