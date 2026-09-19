// biome-ignore-all lint/style/useNamingConvention: the object keys in this file are dotted setting keys ("notifications.telegram.chatId"). They are the primary key of system_settings and the wire name the Settings UI sends back, so they cannot be renamed to camelCase.

/**
 * The registry of every runtime setting this platform knows about.
 *
 * A setting exists here or it does not exist at all: the HTTP layer refuses any
 * key that is not registered, and the store refuses any value the entry's schema
 * rejects. That is what keeps `system_settings` from degenerating into an
 * untyped bag of strings written by whoever touched the UI last.
 *
 * Every entry carries:
 *   category     which Settings tab it belongs to
 *   type         how the UI renders it and how a string is coerced on write
 *   schema       the single source of truth for what a valid value is
 *   default      the value used when no row exists yet (never NULL semantics)
 *   description  shown under the field, in Uzbek, and deliberately honest about
 *                what reads the value today
 *
 * `type: "secret"` means the HTTP layer must never return the stored value.
 * Masking happens in the route handlers, not here - code inside the backend that
 * calls getSetting() gets the real token, because otherwise it could not use it.
 *
 * Values are restricted to string | number | boolean on purpose. Every setting a
 * human edits in a form is a scalar, and keeping it that way lets the API expose
 * one small response schema instead of an open-ended JSON blob.
 */
import { z } from "zod/v4";

/**
 * "recordings" was removed along with its last key: every setting it held was
 * read by nobody. A tab whose fields change nothing is a worse lie than a
 * missing tab, because the owner believes the system is configured. See the
 * comment at the deleted key for what actually controls that behaviour.
 *
 * "ai" was removed for the same reason and is back for the opposite one: every
 * key in it now has a named consumer that reads it per call (see the section at
 * the bottom of the registry). It is edited from the "AI yordamchi" page rather
 * than the Settings page - the Settings page has its own hardcoded tab list and
 * simply ignores a category it does not know, which is what keeps one editor for
 * these values instead of two.
 */
export const SETTING_CATEGORIES = ["general", "pricing", "notifications", "ai"] as const;

export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

/** Tab titles for the Settings page. Uzbek, matching the rest of the UI. */
export const SETTING_CATEGORY_LABELS: Record<SettingCategory, string> = {
	general: "Umumiy",
	pricing: "Narxlar",
	notifications: "Bildirishnomalar",
	ai: "AI ovozli agent",
};

export type SettingValueType = "string" | "number" | "boolean" | "secret";

/** Everything a setting may hold. See the file header for why this is scalar-only. */
export type SettingPrimitive = string | number | boolean;

export interface SettingDefinition {
	category: SettingCategory;
	type: SettingValueType;
	label: string;
	description: string;
	schema: z.ZodType<SettingPrimitive>;
	default: SettingPrimitive;
}

interface TypedSettingDefinition<T extends SettingPrimitive> {
	category: SettingCategory;
	type: SettingValueType;
	label: string;
	description: string;
	schema: z.ZodType<T>;
	default: T;
}

/**
 * Identity helper. Its only job is to tie `schema` and `default` to the same T so
 * a wrong default fails to compile instead of failing at runtime.
 */
function define<T extends SettingPrimitive>(
	definition: TypedSettingDefinition<T>
): TypedSettingDefinition<T> {
	return definition;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ===========================================
// The .env layer
// ===========================================

/**
 * The environment as it was when this process started.
 *
 * Every "ai" entry takes its `default` from here, and that is the whole
 * precedence rule: a stored row wins, no row means the default, and the default
 * IS what .env said. Three layers, one lookup, no branch that can disagree with
 * another - and the Settings API keeps reporting `isStored`, so "changed by hand"
 * is still distinguishable from "as the deployment shipped".
 *
 * It must be a snapshot rather than a live read for two reasons: applying an
 * override mirrors the new value onto process.env (the voice layer reads some
 * variables straight from there), and "put it back to what .env said" has to stay
 * possible afterwards. The snapshot hangs off globalThis because `bun --hot`
 * re-evaluates this module on every save, which would otherwise re-capture an
 * already-overridden process.env and quietly redefine the baseline.
 */
const BOOT_ENV_KEY = Symbol.for("callcenter.settings.bootEnv");

type EnvSnapshot = Readonly<Record<string, string | undefined>>;

const globalStore = globalThis as unknown as Record<symbol, EnvSnapshot | undefined>;

function bootEnv(): EnvSnapshot {
	const captured = globalStore[BOOT_ENV_KEY];

	if (captured !== undefined) {
		return captured;
	}

	const snapshot: EnvSnapshot = { ...process.env };
	globalStore[BOOT_ENV_KEY] = snapshot;

	return snapshot;
}

/** How .env spells "true". Matches provider-factory's own reader. */
const TRUTHY_ENV_VALUES = new Set(["true", "1", "yes", "on"]);

/**
 * Coerce one raw environment string into the entry's type and validate it.
 *
 * An unusable value falls back to the built-in default instead of throwing: a
 * typo in .env must not take the whole registry - and with it every setting the
 * CRM reads - down at import time. Exported for the tests, which is also the
 * only place the raw string is supplied by hand.
 */
export function resolveEnvDefault<T extends SettingPrimitive>(
	schema: z.ZodType<T>,
	raw: string | undefined,
	builtIn: T
): T {
	if (raw === undefined || raw.trim().length === 0) {
		return builtIn;
	}

	const trimmed = raw.trim();
	let candidate: SettingPrimitive = trimmed;

	if (typeof builtIn === "number") {
		candidate = Number(trimmed);
	} else if (typeof builtIn === "boolean") {
		candidate = TRUTHY_ENV_VALUES.has(trimmed.toLowerCase());
	}

	const parsed = schema.safeParse(candidate);

	return parsed.success ? parsed.data : builtIn;
}

function isKnownTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/**
 * An empty string always means "not configured". It is used instead of NULL so
 * every setting has exactly one representation for "no value" and the UI never
 * has to render an undefined input.
 */
const emailOrEmpty: z.ZodType<string> = z
	.string()
	.trim()
	.max(200)
	.refine((value) => value === "" || EMAIL_PATTERN.test(value), {
		message: "Elektron pochta manzili noto'g'ri",
	});

const emailListOrEmpty: z.ZodType<string> = z
	.string()
	.trim()
	.max(1000)
	.refine(
		(value) =>
			value === "" ||
			value
				.split(",")
				.map((part) => part.trim())
				.every((part) => EMAIL_PATTERN.test(part)),
		{ message: "Elektron pochta manzillarini vergul bilan ajratib kiriting" }
	);

const timeZoneName: z.ZodType<string> = z.string().trim().min(1).max(60).refine(isKnownTimeZone, {
	message: "IANA vaqt mintaqasi nomini kiriting, masalan Asia/Tashkent",
});

/** Free-form text that may be left empty (tokens, hostnames, chat ids). */
function optionalText(max: number): z.ZodType<string> {
	return z.string().trim().max(max);
}

/**
 * A token rate in US dollars per million tokens.
 *
 * Deliberately NOT .int(): every real rate has decimals ($0.075 per 1M for a
 * cached mini prompt). 0 means "this line is not priced", which the cost page
 * reports as unpriced rather than as free.
 */
const usdPerMillionTokens: z.ZodType<number> = z.number().min(0).max(10_000);

/**
 * Every rate below ships with the vendor's published list price as its default,
 * so the cost page produces a real number on day one instead of a row of zeros.
 *
 * That convenience is also the trap: this system cannot check a price list, so a
 * default is a guess about someone else's pricing page on some past day. The API
 * therefore reports which rates are still untouched defaults and the page says so
 * out loud - an owner who has not reviewed these is reading an estimate, not a
 * bill. Discounts, free tiers, minimum billing increments and taxes are not
 * modelled at all.
 */
const RATE_NOTE =
	"1 mln token uchun AQSh dollarida. Standart qiymat — e'lon qilingan narxnoma bo'yicha taxmin; " +
	"o'z hisob-fakturangiz bilan solishtirib tasdiqlang. 0 — bu qator narxlanmaydi.";

function rate(label: string, description: string, value: number) {
	return define({
		category: "pricing" as const,
		type: "number" as const,
		label,
		description: `${description} ${RATE_NOTE}`,
		schema: usdPerMillionTokens,
		default: value,
	});
}

// ===========================================
// AI voice agent: shared value shapes
// ===========================================

/**
 * Split a comma-separated setting into its items.
 *
 * Exported because the validator here and every consumer of the same value must
 * split it identically; two splitters that disagree is how "104 " ends up
 * accepted by the form and ignored by the dialler.
 */
export function splitSettingList(raw: string): string[] {
	return raw
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/** A short language tag: "uz", "ru", "uz-UZ". */
const languageTag: z.ZodType<string> = z
	.string()
	.trim()
	.regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, {
		message: "Til kodi noto'g'ri — masalan uz, ru yoki uz-UZ",
	});

/**
 * A vendor voice name.
 *
 * Shape only. WHICH names exist is the provider's own list and is checked by the
 * AI routes against the provider that will actually answer the call, because the
 * two vendors' names are disjoint ("cedar" vs "Callirrhoe") and a name from the
 * wrong vendor is not a typo but a different mistake.
 */
const voiceName: z.ZodType<string> = z
	.string()
	.trim()
	.regex(/^[A-Za-z][A-Za-z0-9_-]{1,49}$/, {
		message:
			"Ovoz nomi lotin harfi bilan boshlanib, faqat harf, raqam, «-» va «_» dan iborat bo'ladi",
	});

/**
 * A model id, plus the one thing about it that can be checked offline: whether
 * this family of model can serve this endpoint at all.
 *
 * That check exists because the failure it prevents is silent. A Gemini model
 * without "live" in its name has no BidiGenerateContent endpoint, an analysis
 * model that is really a realtime model 404s after the call has ended, and a
 * transcription model that is really a chat model returns text that never
 * reaches a transcript. None of those surface as "you typed the wrong model" -
 * they surface as calls that do not work, days later.
 */
function modelName(requirement: string, accept: (value: string) => boolean): z.ZodType<string> {
	return z
		.string()
		.trim()
		.min(3, { message: "Model nomi juda qisqa" })
		.max(80, { message: "Model nomi juda uzun" })
		.regex(/^[a-z0-9][a-z0-9._:/-]*$/, {
			message:
				"Model nomi kichik harf yoki raqamdan boshlanib, «-», «.», «_», «:», «/» belgilarini qabul qiladi",
		})
		.refine(accept, { message: requirement });
}

const extensionNumber: z.ZodType<string> = z
	.string()
	.trim()
	.regex(/^\d{2,6}$/, { message: "Ichki raqam 2–6 xonali son bo'lishi kerak, masalan 900" });

/**
 * A comma-separated transfer pool.
 *
 * Empty is legal and means "no configured pool": lib/telephony/transfer.ts then
 * falls back to the enabled rows in sip_extensions, which is a working setup and
 * not a mistake.
 */
const extensionList: z.ZodType<string> = z
	.string()
	.trim()
	.max(200, { message: "Ro'yxat juda uzun" })
	.refine((value) => splitSettingList(value).every((item) => /^\d{2,6}$/.test(item)), {
		message: "Ichki raqamlarni vergul bilan ajratib yozing, masalan 101,102,103",
	})
	.refine((value) => splitSettingList(value).length <= 20, {
		message: "Ko'pi bilan 20 ta ichki raqam kiritish mumkin",
	})
	.refine((value) => new Set(splitSettingList(value)).size === splitSettingList(value).length, {
		message: "Ro'yxatda takrorlangan ichki raqam bor",
	});

/**
 * How a campaign call's number is turned into something Asterisk can dial.
 *
 * A pattern rather than a fixed string because the same code has to serve two
 * very different deployments: today, with no carrier, only internal PJSIP
 * extensions exist and "PJSIP/{number}" is the whole truth; the day a SIP trunk
 * is bought, "PJSIP/{number}@trunk-<slug>" is - and that must be a setting somebody
 * types, not a release. The trunk carries the tenant slug because every customer
 * has their OWN carrier: see lib/tenancy/asterisk-naming.ts.
 *
 * The token is required: a pattern with no {number} in it would dial the same
 * endpoint for every lead in the list, which is the one failure here that is both
 * silent and unforgivable.
 */
const dialPattern: z.ZodType<string> = z
	.string()
	.trim()
	.min(3)
	.max(120)
	.refine((value) => value.includes("{number}"), {
		message:
			"Shablonda «{number}» bo'lishi shart, masalan PJSIP/{number} yoki PJSIP/{number}@trunk-avilab",
	})
	.refine((value) => /^[A-Za-z][A-Za-z0-9]*\/\S+$/.test(value), {
		message:
			"Shablon «TEXNOLOGIYA/manzil» ko'rinishida bo'ladi va bo'sh joy bo'lmaydi, masalan PJSIP/{number}",
	});

/** A number a carrier will accept as caller id, or empty for "let Asterisk decide". */
const callerIdOrEmpty: z.ZodType<string> = z
	.string()
	.trim()
	.max(32)
	.refine((value) => value === "" || /^\+?\d{3,20}$/.test(value), {
		message: "Faqat raqamlardan iborat bo'lsin (oldida «+» bo'lishi mumkin), masalan 998712001122",
	});

function integer(min: number, max: number, unit: string): z.ZodType<number> {
	return z
		.number({ message: "Son kiriting" })
		.int({ message: "Butun son kiriting" })
		.min(min, { message: `Kamida ${min} ${unit}` })
		.max(max, { message: `Ko'pi bilan ${max} ${unit}` });
}

function decimal(min: number, max: number): z.ZodType<number> {
	return z
		.number({ message: "Son kiriting" })
		.min(min, { message: `Kamida ${min}` })
		.max(max, { message: `Ko'pi bilan ${max}` });
}

/**
 * The dialects the agent can be asked to LISTEN for. Not ones it speaks.
 *
 * The agent understands all of them on every call and always answers in standard
 * Uzbek (see buildDialectSection in lib/ai/prompts.ts); this value only says
 * which region rings this number most, so an ambiguous word is read that way
 * first.
 *
 * A closed list rather than free text on purpose: the prompt builder has to
 * recognise the value to do anything with it, so a typed-in "хорезмский" would
 * save happily and change nothing - the exact class of dead control this
 * category exists to remove. Exported so the dashboard offers the same list the
 * prompt builder switches on.
 */
export const AI_DIALECTS = [
	"neutral",
	"toshkent",
	"xorazm",
	"fargona",
	"samarqand",
	"buxoro",
] as const;

export type AiDialect = (typeof AI_DIALECTS)[number];

/**
 * Uzbek names for the dialect slugs, for a dropdown.
 *
 * Worded as what is HEARD, not as what is spoken: "Xorazm shevasi" on its own
 * reads as a promise that the agent will answer in it, which is exactly the
 * behaviour that was removed.
 */
export const AI_DIALECT_LABELS: Record<AiDialect, string> = {
	neutral: "Alohida viloyat ajratilmagan",
	toshkent: "Ko'proq Toshkent shevasi eshitiladi",
	xorazm: "Ko'proq Xorazm shevasi eshitiladi",
	fargona: "Ko'proq Farg'ona vodiysi shevasi eshitiladi",
	samarqand: "Ko'proq Samarqand shevasi eshitiladi",
	buxoro: "Ko'proq Buxoro shevasi eshitiladi",
};

/** Google's two documented sensitivity levels, per direction. */
export const AI_VAD_START_SENSITIVITIES = [
	"START_SENSITIVITY_LOW",
	"START_SENSITIVITY_HIGH",
] as const;
export const AI_VAD_END_SENSITIVITIES = ["END_SENSITIVITY_LOW", "END_SENSITIVITY_HIGH"] as const;

export const AI_VOICE_PROVIDERS = ["openai", "gemini"] as const;

export type AiVoiceProviderKind = (typeof AI_VOICE_PROVIDERS)[number];

/**
 * One "ai" entry.
 *
 * `env` names the variable the value shipped in, which is what makes the .env
 * layer real: with no stored row, getSetting() returns what .env said, and only
 * a value that .env never carried falls back to `default`.
 */
function aiSetting<T extends SettingPrimitive>(definition: {
	type: SettingValueType;
	label: string;
	description: string;
	schema: z.ZodType<T>;
	/** The variable this used to be configured with, if any. */
	env?: string;
	default: T;
}): TypedSettingDefinition<T> {
	return define({
		category: "ai" as const,
		type: definition.type,
		label: definition.label,
		description: definition.description,
		schema: definition.schema,
		default:
			definition.env === undefined
				? definition.default
				: resolveEnvDefault(definition.schema, bootEnv()[definition.env], definition.default),
	});
}

export const SETTINGS_REGISTRY = {
	// ===========================================
	// Umumiy
	// ===========================================
	"general.organizationName": define({
		category: "general",
		type: "string",
		label: "Tashkilot nomi",
		description:
			"Hisobot va eksport fayllarining sarlavhasida ishlatish uchun saqlanadi. Qiymatni backendning boshqa modullari lib/settings orqali o'qiydi.",
		schema: z.string().trim().min(1).max(120),
		default: "Aqlli Shahar",
	}),
	"general.timezone": define({
		category: "general",
		type: "string",
		label: "Vaqt mintaqasi",
		description:
			"Kunlik hisobot chegaralari shu mintaqa bo'yicha hisoblanishi uchun saqlanadi (IANA nomi, masalan Asia/Tashkent).",
		schema: timeZoneName,
		default: "Asia/Tashkent",
	}),

	// "ai.greeting" hali ham yo'q: tabriklashni `ai_agent_profiles.greeting`
	// («Biznes profili» bo'limi) beradi, ya'ni bu yerda ikkinchi tabriklash
	// maydoni bo'lsa ikkitasi bir-biriga qarshi turardi. Qolgan AI sozlamalari
	// faylning oxiridagi "AI ovozli agent" bo'limida — har birining o'qiydigan
	// joyi izohida ko'rsatilgan.

	// ===========================================
	// Narxlar
	// ===========================================
	// Rates are keyed by PROVIDER, not by provider+model: there are two providers
	// and swapping the model within one is a config change, not a new price list.
	// Which model actually ran is recorded per session and shown on the cost page's
	// provider/model split, so a rate that stopped matching the model is visible.
	"pricing.usdToUzs": define({
		category: "pricing",
		type: "number",
		label: "1 AQSh dollari necha so'm",
		description:
			"AI xarajatlari sahifasida dollar yonida so'mdagi qiymatni ko'rsatish uchun. 0 — faqat dollarda ko'rsatiladi. Kurs qo'lda kiritiladi, hech qayerdan avtomatik olinmaydi.",
		schema: z.number().min(0).max(1_000_000),
		default: 0,
	}),

	"pricing.openaiRealtime.textInputPer1M": rate(
		"OpenAI Realtime — matnli kirish",
		"Suhbat davomida modelga yuborilgan matn tokenlari (yo'riqnoma, bilimlar bazasi, vositalar).",
		4
	),
	"pricing.openaiRealtime.textInputCachedPer1M": rate(
		"OpenAI Realtime — keshdan olingan matnli kirish",
		"Har javobda qayta o'qiladigan matnli prefiks keshdan olinsa shu narxda hisoblanadi.",
		0.4
	),
	"pricing.openaiRealtime.audioInputPer1M": rate(
		"OpenAI Realtime — audio kirish",
		"Mijoz ovozi model uchun tokenga aylantirilgani.",
		32
	),
	"pricing.openaiRealtime.audioInputCachedPer1M": rate(
		"OpenAI Realtime — keshdan olingan audio kirish",
		"Oldingi javoblardagi audio keshdan qayta o'qilgani.",
		0.4
	),
	"pricing.openaiRealtime.textOutputPer1M": rate(
		"OpenAI Realtime — matnli chiqish",
		"Model yozgan matn (vosita chaqiruvlari, transkript).",
		16
	),
	"pricing.openaiRealtime.audioOutputPer1M": rate(
		"OpenAI Realtime — audio chiqish",
		"Model gapirgan ovoz — odatda eng qimmat qator.",
		64
	),

	"pricing.geminiLive.textInputPer1M": rate(
		"Gemini Live — matnli kirish",
		"Modelga yuborilgan matn tokenlari.",
		0.5
	),
	"pricing.geminiLive.textInputCachedPer1M": rate(
		"Gemini Live — keshdan olingan matnli kirish",
		"Standart qiymat oddiy matnli kirish bilan bir xil: bu yerda kesh chegirmasi modellashtirilmagan, ya'ni narx kam ko'rsatilmaydi. Chegirma borligini bilsangiz o'zgartiring.",
		0.5
	),
	"pricing.geminiLive.audioInputPer1M": rate(
		"Gemini Live — audio kirish",
		"Mijoz ovozi tokenga aylantirilgani.",
		3
	),
	"pricing.geminiLive.audioInputCachedPer1M": rate(
		"Gemini Live — keshdan olingan audio kirish",
		"Standart qiymat oddiy audio kirish bilan bir xil — kesh chegirmasi modellashtirilmagan.",
		3
	),
	"pricing.geminiLive.textOutputPer1M": rate(
		"Gemini Live — matnli chiqish",
		"Model yozgan matn.",
		2
	),
	"pricing.geminiLive.audioOutputPer1M": rate(
		"Gemini Live — audio chiqish",
		"Model gapirgan ovoz.",
		12
	),

	"pricing.transcribe.audioInputPer1M": rate(
		"Transkripsiya — audio kirish",
		"Mijoz nutqini matnga o'girish (gpt-4o-transcribe) alohida hisoblanadi va faqat OpenAI yo'lida bo'ladi. Gemini buni suhbat ichida bajaradi, alohida to'lovsiz.",
		6
	),
	"pricing.transcribe.textOutputPer1M": rate(
		"Transkripsiya — matnli chiqish",
		"Transkripsiya qaytargan matn tokenlari.",
		10
	),

	"pricing.analysis.inputPer1M": rate(
		"Qo'ng'iroqdan keyingi tahlil — kirish",
		// The env key is OPENAI_ANALYSIS_MODEL; it belongs here, not in copy the owner reads.
		"Suhbat yakunlangach ishlaydigan xulosa modeli (hozircha gpt-4o-mini).",
		0.15
	),
	"pricing.analysis.cachedInputPer1M": rate(
		"Qo'ng'iroqdan keyingi tahlil — keshdan olingan kirish",
		"Xulosa modelining keshdan o'qilgan kirish tokenlari.",
		0.075
	),
	"pricing.analysis.outputPer1M": rate(
		"Qo'ng'iroqdan keyingi tahlil — chiqish",
		"Xulosa modeli yozgan matn.",
		0.6
	),

	// ===========================================
	// Bildirishnomalar
	// ===========================================
	"notifications.enabled": define({
		category: "notifications",
		type: "boolean",
		label: "Bildirishnomalar yoqilgan",
		description: "O'chirilgan bo'lsa hech qanday Telegram yoki email bildirishnomasi yuborilmaydi.",
		schema: z.boolean({ error: "Faqat yoqilgan yoki o'chirilgan bo'lishi mumkin" }),
		default: false,
	}),
	"notifications.telegram.botToken": define({
		category: "notifications",
		type: "secret",
		label: "Telegram bot tokeni",
		description:
			"@BotFather bergan token. «Telegramni tekshirish» tugmasi tokenni Telegram API orqali haqiqiy so'rov bilan tasdiqlaydi.",
		schema: optionalText(200),
		default: "",
	}),
	"notifications.telegram.chatId": define({
		category: "notifications",
		type: "string",
		label: "Telegram chat ID",
		description:
			"Xabar yuboriladigan chat yoki kanal identifikatori (masalan -1001234567890 yoki @kanal_nomi).",
		schema: optionalText(120),
		default: "",
	}),
	"notifications.email.host": define({
		category: "notifications",
		type: "string",
		label: "SMTP server",
		description: "SMTP serverning hosti, masalan smtp.example.com.",
		schema: optionalText(200),
		default: "",
	}),
	"notifications.email.port": define({
		category: "notifications",
		type: "number",
		label: "SMTP port",
		description: "Odatda 587 (STARTTLS) yoki 465 (SSL).",
		schema: z.number().int().min(1).max(65535),
		default: 587,
	}),
	"notifications.email.secure": define({
		category: "notifications",
		type: "boolean",
		label: "SMTP uchun SSL/TLS",
		description: "465 portida yoqilgan bo'lishi kerak; 587 portida odatda o'chirilgan.",
		schema: z.boolean({ error: "Faqat yoqilgan yoki o'chirilgan bo'lishi mumkin" }),
		default: false,
	}),
	"notifications.email.username": define({
		category: "notifications",
		type: "string",
		label: "SMTP foydalanuvchi",
		description: "SMTP serverga kirish uchun login.",
		schema: optionalText(200),
		default: "",
	}),
	"notifications.email.password": define({
		category: "notifications",
		type: "secret",
		label: "SMTP parol",
		description: "Saqlangan parol brauzerga qaytarilmaydi — faqat «***» ko'rinadi.",
		schema: optionalText(200),
		default: "",
	}),
	"notifications.email.fromAddress": define({
		category: "notifications",
		type: "string",
		label: "Yuboruvchi manzili",
		description: "Xatlar shu manzildan yuboriladi.",
		schema: emailOrEmpty,
		default: "",
	}),
	"notifications.email.toAddresses": define({
		category: "notifications",
		type: "string",
		label: "Qabul qiluvchilar",
		description: "Bir nechta manzilni vergul bilan ajratib yozing.",
		schema: emailListOrEmpty,
		default: "",
	}),

	// ===========================================
	// AI ovozli agent
	//
	// Bu bo'limdagi har bir qiymatni o'qiydigan aniq joy bor va u izohda
	// yozilgan. Qiymatlar lib/settings/ai-config.ts orqali har qo'ng'iroq
	// boshida qayta o'qiladi, ya'ni o'zgartirish keyingi qo'ng'iroqdan boshlab
	// ishlaydi — backendni qayta ishga tushirish shart emas. Faqat
	// ai.agentExtension bundan mustasno: uni Asterisk dialplan'i ham biladi.
	// ===========================================
	"ai.enabled": aiSetting({
		type: "boolean",
		env: "AI_AGENT_ENABLED",
		label: "AI agent yoqilgan",
		description:
			"O'chirilsa AI qo'ng'iroqqa javob bermaydi: chaqiruv IVR zaxirasiga tushadi va operatorga uzatiladi. " +
			"resolveVoiceProvider() har qo'ng'iroqda o'qiydi — keyingi qo'ng'iroqdan boshlab ishlaydi.",
		schema: z.boolean({ error: "Faqat yoqilgan yoki o'chirilgan bo'lishi mumkin" }),
		default: true,
	}),
	"ai.provider": aiSetting({
		type: "string",
		env: "AI_VOICE_PROVIDER",
		label: "Ovozli provayder",
		description:
			"«gemini» — Google Gemini Live, «openai» — OpenAI Realtime. Ovozlar ro'yxati, model va gapirish " +
			"sozlamalari tanlangan provayderga bog'liq. Kaliti yo'q provayderga o'tishga ruxsat berilmaydi, " +
			"chunki bunda har bir qo'ng'iroq jimgina IVR zaxirasiga tushib qolardi.",
		schema: z
			.string()
			.trim()
			.toLowerCase()
			.pipe(z.enum(AI_VOICE_PROVIDERS, { error: "Faqat «openai» yoki «gemini» bo'lishi mumkin" })),
		default: "openai",
	}),
	"ai.language": aiSetting({
		type: "string",
		env: "AI_AGENT_LANGUAGE",
		label: "Suhbat tili",
		description:
			"Biznes profilida til ko'rsatilmagan bo'lsa shu til ishlatiladi. Platformaning o'z gaplari " +
			"(«operatorga ulayapman», xayrlashuv) ham shu til bo'yicha tanlanadi — qo'ng'iroq vaqtida " +
			"o'qiladi, restart talab qilmaydi.",
		schema: languageTag,
		default: "uz",
	}),
	"ai.dialect": aiSetting({
		type: "string",
		label: "Sheva — qaysi shevani ko'proq tushunishi kerak",
		description:
			"AI barcha shevalarni («hovva», «kelvotti», «opke», «kelibman») HAR DOIM tushunadi va javobni " +
			"HAR DOIM toza adabiy o'zbek tilida beradi — hech qachon shevada gapirmaydi va mijozning " +
			"gapini takrorlamaydi. Bu yerda faqat shu raqamga ko'proq qaysi viloyatdan qo'ng'iroq " +
			"kelishini ko'rsatasiz: so'z ikki xil tushunilishi mumkin bo'lsa, avval o'sha shevadagi " +
			`ma'nosi olinadi. Mumkin qiymatlar: ${AI_DIALECTS.join(", ")}. «neutral» — alohida viloyat ` +
			"ajratilmaydi.",
		schema: z
			.string()
			.trim()
			.toLowerCase()
			.pipe(
				z.enum(AI_DIALECTS, {
					error: `Bunday sheva ro'yxatda yo'q. Mumkin: ${AI_DIALECTS.join(", ")}`,
				})
			),
		default: "neutral",
	}),

	"ai.gemini.voice": aiSetting({
		type: "string",
		env: "GEMINI_LIVE_VOICE",
		label: "Gemini ovozi",
		description:
			"Gemini Live provayderi gapiradigan ovoz. Ro'yxat GET /api/ai-assistant/config javobidagi " +
			"`knownVoices` da — ro'yxatda yo'q nom qabul qilinmaydi, chunki provayder bunday nomni jimgina " +
			"standart ovozga almashtirib yuboradi.",
		schema: voiceName,
		default: "Callirrhoe",
	}),
	"ai.gemini.model": aiSetting({
		type: "string",
		env: "GEMINI_LIVE_MODEL",
		label: "Gemini Live modeli",
		description:
			"Ovozli suhbatni olib boradigan model, masalan gemini-3.1-flash-live-preview. Nomida «live» " +
			"bo'lishi shart: boshqa Gemini modellarida real vaqtli (BidiGenerateContent) endpoint yo'q.",
		schema: modelName(
			"Gemini Live modeli nomida «live» bo'lishi shart, masalan gemini-3.1-flash-live-preview",
			(value) => value.includes("live")
		),
		default: "gemini-2.0-flash-live-001",
	}),
	"ai.openai.voice": aiSetting({
		type: "string",
		env: "OPENAI_REALTIME_VOICE",
		label: "OpenAI ovozi",
		description:
			"OpenAI Realtime provayderi gapiradigan ovoz. Gemini nomlari bilan aralashtirib bo'lmaydi — " +
			"ikki vendorda umumiy ovoz nomi yo'q.",
		schema: voiceName,
		default: "alloy",
	}),
	"ai.openai.model": aiSetting({
		type: "string",
		env: "OPENAI_REALTIME_MODEL",
		label: "OpenAI Realtime modeli",
		description:
			"Nomida «realtime» bo'lishi shart (masalan gpt-realtime): oddiy chat modeli ovozli sessiya " +
			"ochmaydi.",
		schema: modelName(
			"OpenAI Realtime modeli nomida «realtime» bo'lishi shart, masalan gpt-realtime",
			(value) => value.includes("realtime")
		),
		default: "gpt-realtime",
	}),
	"ai.transcribeModel": aiSetting({
		type: "string",
		env: "OPENAI_TRANSCRIBE_MODEL",
		label: "Transkripsiya modeli",
		description:
			"Mijoz nutqini matnga o'giradigan model (faqat OpenAI yo'lida ishlatiladi — Gemini buni suhbat " +
			"ichida bajaradi). Nomida «transcribe» yoki «whisper» bo'lishi shart, aks holda transkript " +
			"jimgina bo'sh qoladi.",
		schema: modelName(
			"Transkripsiya modeli nomida «transcribe» yoki «whisper» bo'lishi shart, masalan gpt-4o-transcribe",
			(value) => value.includes("transcribe") || value.includes("whisper")
		),
		default: "gpt-4o-transcribe",
	}),
	"ai.analysisModel": aiSetting({
		type: "string",
		env: "OPENAI_ANALYSIS_MODEL",
		label: "Qo'ng'iroqdan keyingi tahlil modeli",
		description:
			"Suhbat tugagach xulosa, kayfiyat va toifani yozadigan matnli model (/chat/completions). " +
			"Realtime, live, transcribe yoki whisper modellari bu endpointda ishlamaydi, shuning uchun " +
			"ularning nomi qabul qilinmaydi.",
		schema: modelName(
			"Tahlil uchun oddiy matnli (chat) model kerak — realtime, live, transcribe va whisper modellari " +
				"/chat/completions bilan ishlamaydi",
			(value) =>
				!(
					value.includes("realtime") ||
					value.includes("live") ||
					value.includes("transcribe") ||
					value.includes("whisper") ||
					value.includes("embedding") ||
					value.includes("tts")
				)
		),
		default: "gpt-4o-mini",
	}),

	"ai.maxCallSeconds": aiSetting({
		type: "number",
		env: "AI_AGENT_MAX_CALL_SECONDS",
		label: "Qo'ng'iroqning eng uzun davomiyligi (sekund)",
		description:
			"Shu vaqtdan keyin AI xayrlashib go'shakni qo'yadi. Biznes profilida o'z chegarasi bo'lsa u " +
			"ustun turadi; bu qiymat profili sozlanmagan deploymentlar uchun. Har qo'ng'iroqda o'qiladi.",
		schema: integer(30, 7200, "sekund"),
		default: 900,
	}),
	"ai.silenceHangupMs": aiSetting({
		type: "number",
		env: "AI_AGENT_SILENCE_HANGUP_MS",
		label: "Jimlikdan keyin uzish (ms)",
		description:
			"Liniyada shu vaqt hech qanday harakat bo'lmasa qo'ng'iroq tugatiladi. Biznes profilidagi " +
			"qiymat ustun turadi. Har qo'ng'iroqda o'qiladi.",
		schema: integer(1000, 300_000, "ms"),
		default: 20_000,
	}),
	"ai.greetingDelayMs": aiSetting({
		type: "number",
		env: "AI_AGENT_GREETING_DELAY_MS",
		label: "Tabriklashdan oldingi pauza (ms)",
		description:
			"Audio kanal ulangandan keyin AI gapirishni boshlashigacha kutiladigan vaqt. Juda kichik qiymat " +
			"tabriklashning boshini kesib qoldiradi, juda katta qiymat esa «jim liniya» taassurotini beradi.",
		schema: integer(0, 10_000, "ms"),
		default: 400,
	}),

	"ai.agentExtension": aiSetting({
		type: "string",
		env: "AI_AGENT_EXTENSION",
		label: "AI agentning ichki raqami",
		description:
			"Backend shu raqamni «bu AI o'zi» deb biladi: uni operatorga uzatish ro'yxatidan va " +
			"click-to-call dan chiqarib tashlaydi. DIQQAT: qo'ng'iroqni AI ga yo'naltirishni Asterisk " +
			"dialplan'i qiladi (extensions.conf ichida «exten => 900»), shuning uchun raqamni bu yerda " +
			"o'zgartirsangiz dialplan'ni ham o'zgartirib Asterisk'ni reload qilish kerak.",
		schema: extensionNumber,
		default: "900",
	}),
	"ai.transferExtensions": aiSetting({
		type: "string",
		env: "AI_TRANSFER_EXTENSIONS",
		label: "Operatorlarga uzatish ro'yxati",
		description:
			"AI qo'ng'iroqni uzatishga harakat qiladigan ichki raqamlar, vergul bilan. Bo'sh qoldirilsa " +
			"sip_extensions jadvalidagi yoqilgan raqamlar ishlatiladi. Dialplan hozir faqat 1XX va 2XX " +
			"raqamlarini uzatadi.",
		schema: extensionList,
		default: "101,102,103,104",
	}),

	// -------------------------------------------
	// Chiquvchi (kampaniya) qo'ng'iroqlari
	//
	// Bu to'rt qiymatni lib/telephony/outbound.ts o'qiydi — har bir qo'ng'iroqdan
	// oldin, ya'ni o'zgartirish keyingi qo'ng'iroqdan boshlab ishlaydi.
	// -------------------------------------------
	"ai.outbound.dialPattern": aiSetting({
		type: "string",
		env: "OUTBOUND_DIAL_PATTERN",
		label: "Chiquvchi qo'ng'iroq uchun raqam shabloni",
		description:
			"AI kampaniya qo'ng'irog'ini qanday teradi. «{number}» o'rniga ro'yxatdagi raqam qo'yiladi. " +
			"Standart «PJSIP/{number}» — bu holda faqat ichki raqamlarga (101, 201) qo'ng'iroq qilinadi, " +
			"chunki hozir SIP trunk ulanmagan. Haqiqiy trunk olganingizdan keyin .env dagi SIP_TRUNK_HOST, " +
			"SIP_TRUNK_USERNAME, SIP_TRUNK_PASSWORD ni to'ldirib Asterisk'ni qayta ishga tushiring va bu " +
			"yerga «PJSIP/{number}@trunk-<slug>» deb yozing (slug — sizning tashkilot kodingiz, masalan " +
			"«trunk-avilab»): har bir mijozning trunk'i o'ziga tegishli. Kodda hech narsa o'zgartirilmaydi.",
		schema: dialPattern,
		default: "PJSIP/{number}",
	}),
	"ai.outbound.callerId": aiSetting({
		type: "string",
		env: "SIP_TRUNK_DID",
		label: "Chiquvchi qo'ng'iroqda ko'rinadigan raqam",
		description:
			"Kampaniya qo'ng'irog'ida odamning telefonida ko'rinadigan raqam (Caller ID). Bo'sh qoldirilsa " +
			"Asterisk o'zi tanlaydi. Ko'pchilik provayder faqat o'zi bergan raqamni (SIP_TRUNK_DID) qabul " +
			"qiladi, boshqa raqam yuborilsa qo'ng'iroqni rad etadi.",
		schema: callerIdOrEmpty,
		default: "",
	}),
	"ai.outbound.ringTimeoutSeconds": aiSetting({
		type: "number",
		label: "Go'shak ko'tarilishini kutish (sekund)",
		description:
			"Kampaniya qo'ng'irog'ida shu vaqt ichida javob bo'lmasa, qo'ng'iroq «javob bo'lmadi» deb " +
			"yopiladi va keyinroq qayta urinish kampaniya sozlamasiga qoladi. 25–35 sekund odatiy qiymat: " +
			"undan kamida telefonni cho'ntagidan olayotgan odam ulgurmaydi.",
		schema: integer(5, 120, "sekund"),
		default: 30,
	}),
	"ai.outbound.maxConcurrentCalls": aiSetting({
		type: "number",
		label: "Bir vaqtda nechta chiquvchi qo'ng'iroq",
		description:
			"Platforma bir paytda shu qadar chiquvchi qo'ng'iroqdan ko'pini boshlamaydi — trunk kanallari " +
			"va AI provayderining cheklovi shu bilan himoyalanadi. Bu umumiy chegara: alohida kampaniyaning " +
			"o'z chegarasi bundan oshib ketolmaydi.",
		schema: integer(1, 50, "qo'ng'iroq"),
		default: 3,
	}),

	// -------------------------------------------
	// Gemini Live: gapirish uslubi
	//
	// Bu yerdagi nomlar setup kadrining o'z nomlari. Model qabul qiladigan
	// maydonlar o'lchab tekshirilgan; qabul qilmaydiganlari (enableAffectiveDialog,
	// proactivity) ataylab yo'q — ular soketni 1007 bilan yopadi.
	// -------------------------------------------
	"ai.gemini.temperature": aiSetting({
		type: "number",
		label: "Temperatura",
		description:
			"generationConfig.temperature. Past qiymat — bir xil, quruq javoblar; yuqori qiymat — " +
			"jonli, lekin bilim bazasidan chetga chiqishga moyil. Odamiy suhbat uchun 0.7–1.0 orasi.",
		schema: decimal(0, 2),
		default: 0.85,
	}),
	"ai.gemini.topP": aiSetting({
		type: "number",
		label: "topP",
		description:
			"generationConfig.topP — so'z tanlashdagi ehtimollik chegarasi. 1 ga yaqin qiymat tabiiyroq " +
			"ohang beradi, kichik qiymat gaplarni bir xillashtiradi.",
		schema: decimal(0, 1),
		default: 0.95,
	}),
	"ai.gemini.maxOutputTokens": aiSetting({
		type: "number",
		label: "Bitta javobdagi eng ko'p token",
		description:
			"generationConfig.maxOutputTokens. 0 — chegara yuborilmaydi (model o'z standartini ishlatadi). " +
			"Kichik qiymat javobni gap o'rtasida kesib qoldirishi mumkin.",
		schema: integer(0, 32_768, "token"),
		default: 0,
	}),
	"ai.gemini.languageCode": aiSetting({
		type: "string",
		label: "Ovoz tili kodi (speechConfig)",
		description:
			"speechConfig.languageCode — model qaysi til talaffuzida gapirishi. To'liq ko'rinishda " +
			"yoziladi: uz-UZ, ru-RU. Bo'sh qoldirilsa maydon yuborilmaydi va model tilni o'zi tanlaydi.",
		schema: z
			.string()
			.trim()
			.refine((value) => value === "" || /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})+$/.test(value), {
				message: "Til kodini mintaqasi bilan yozing, masalan uz-UZ yoki ru-RU",
			}),
		default: "uz-UZ",
	}),
	"ai.gemini.vadStartSensitivity": aiSetting({
		type: "string",
		label: "Gapirish boshlanishini sezish",
		description:
			"automaticActivityDetection.startOfSpeechSensitivity. HIGH — mijoz gapira boshlaganini tez " +
			"sezadi va AI darhol jim bo'ladi (suhbat tabiiyroq, lekin shovqinli liniyada yolg'on " +
			"ishga tushish bo'ladi). LOW — aksincha.",
		schema: z
			.string()
			.trim()
			.toUpperCase()
			.pipe(
				z.enum(AI_VAD_START_SENSITIVITIES, {
					error: `Faqat ${AI_VAD_START_SENSITIVITIES.join(" yoki ")}`,
				})
			),
		default: "START_SENSITIVITY_HIGH",
	}),
	"ai.gemini.vadEndSensitivity": aiSetting({
		type: "string",
		label: "Gapirish tugaganini sezish",
		description:
			"automaticActivityDetection.endOfSpeechSensitivity. LOW — mijozning gap orasidagi pauzasini " +
			"«tugadi» deb hisoblamaydi, ya'ni gapini kesmaydi (sekinroq javob). HIGH — tezroq javob " +
			"beradi, lekin o'ylab turgan odamning gapini kesib qolishi mumkin.",
		schema: z
			.string()
			.trim()
			.toUpperCase()
			.pipe(
				z.enum(AI_VAD_END_SENSITIVITIES, {
					error: `Faqat ${AI_VAD_END_SENSITIVITIES.join(" yoki ")}`,
				})
			),
		default: "END_SENSITIVITY_LOW",
	}),
	"ai.gemini.vadPrefixPaddingMs": aiSetting({
		type: "number",
		label: "Nutq boshidagi zaxira (ms)",
		description:
			"automaticActivityDetection.prefixPaddingMs — nutq deb tan olinishidan oldingi audio ham " +
			"hisobga olinadi, shunda so'zning birinchi bo'g'ini yo'qolmaydi.",
		schema: integer(0, 5000, "ms"),
		default: 200,
	}),
	"ai.gemini.vadSilenceDurationMs": aiSetting({
		type: "number",
		label: "Javobdan oldingi jimlik (ms)",
		description:
			"automaticActivityDetection.silenceDurationMs — mijoz gapini tugatdi deb hisoblash uchun " +
			"kerakli jimlik. Kichik qiymat AI ni gapga suqiluvchan qiladi, katta qiymat suhbatni " +
			"sekinlashtiradi. Telefonda 400–800 ms odamiy tuyuladi.",
		schema: integer(50, 10_000, "ms"),
		default: 600,
	}),

	// -------------------------------------------
	// Telefon liniyasidagi ovoz tiniqligi
	//
	// Bu ikki maydon modelga emas, chiquvchi audioga tegishli: AI ovozi mijozga
	// yuborilishidan oldin shu yerdagi qiymatlar bilan ishlanadi. O'lchov
	// natijalari lib/ai/codec.ts da yozilgan.
	// -------------------------------------------
	"ai.audio.presenceDb": aiSetting({
		type: "number",
		label: "Ovoz tiniqligi (dB)",
		description:
			"Telefon liniyasi 300–3400 Hz ni o'tkazadi va so'zlarni ajratib turadigan undosh tovushlar " +
			"shu oraliqning yuqori qismida — 1200–3400 Hz da — yotadi. Model ovozida aynan shu qism " +
			"o'lchov bo'yicha 15–32 dB past, shuning uchun ovoz «xira» eshitiladi. Bu qiymat 2100 Hz " +
			"atrofidagi kengaytmani ko'taradi: 6 dB — o'lchovga asoslangan standart, 8–10 dB — juda " +
			"bo'g'iq ovozlar uchun, 0 — filtr butunlay o'chadi. Yangi qo'ng'iroqdan boshlab ishlaydi.",
		schema: decimal(0, 12),
		default: 6,
	}),
	"ai.audio.outputGainDb": aiSetting({
		type: "number",
		label: "Chiquvchi ovoz balandligi (dB)",
		description:
			"Tiniqlik filtridan keyin qo'shiladigan balandlik. Ortidan cheklagich (limiter) turadi, " +
			"shuning uchun ovoz baland bo'lsa ham buzilmaydi va «xirillash» paydo bo'lmaydi — aksincha, " +
			"qo'ng'iroq boshida sekin, oxirida baland bo'lib qolmaydi. 3 dB — tavsiya etilgan qiymat, " +
			"0 — balandlikka umuman tegilmaydi.",
		schema: decimal(0, 12),
		default: 3,
	}),

	// "recordings.retentionDays" ataylab olib tashlandi: hech qanday tozalash
	// vazifasi mavjud emas, ya'ni maydon "90 kundan keyin o'chiriladi" deb va'da
	// berardi va hech narsa o'chirilmasdi. Bunday va'daga tayanib qolish
	// (masalan, ma'lumotlarni saqlash siyosati uchun) oddiy chalkashlikdan
	// ko'ra xavfliroq. Haqiqiy tozalash kerak bo'lsa, avval vazifaning o'zi
	// yozilsin, keyin sozlama qaytarilsin.
};

export type SettingKey = keyof typeof SETTINGS_REGISTRY;

/** The value type a given key holds, taken straight from its schema. */
export type SettingValueOf<K extends SettingKey> = z.infer<(typeof SETTINGS_REGISTRY)[K]["schema"]>;

/**
 * The same registry seen through one uniform type, for the code that iterates
 * over every entry (the store, the HTTP layer). The cast is safe because every
 * entry is built by define() with T extends SettingPrimitive; it is only needed
 * because each entry has its own narrower schema type.
 */
export const SETTING_DEFINITIONS = SETTINGS_REGISTRY as unknown as Record<
	SettingKey,
	SettingDefinition
>;

/** Registry order, which is also the order the API and the UI present. */
export const SETTING_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
	return Object.hasOwn(SETTINGS_REGISTRY, key);
}

export function getSettingDefinition(key: SettingKey): SettingDefinition {
	return SETTING_DEFINITIONS[key];
}

export function getSettingKeysByCategory(category: SettingCategory): SettingKey[] {
	return SETTING_KEYS.filter((key) => SETTING_DEFINITIONS[key].category === category);
}

/**
 * Coerce a value that arrived over HTTP into the entry's own type.
 *
 * JSON already distinguishes numbers and booleans, so this only matters for
 * clients that send everything as a string (a form post, a curl one-liner). An
 * uncoercible value is returned unchanged and the schema rejects it, so the
 * caller still gets a proper validation error naming the field.
 */
export function coerceSettingValue(
	definition: SettingDefinition,
	value: SettingPrimitive
): SettingPrimitive {
	if (definition.type === "number" && typeof value === "string") {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : value;
	}

	if (definition.type === "boolean" && typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") {
			return true;
		}
		if (normalized === "false") {
			return false;
		}
	}

	return value;
}
