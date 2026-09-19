/**
 * The demo tenant: AviLab, a real software and AI studio in Urganch.
 *
 * The platform itself is business-agnostic - everything the agent says comes out
 * of these rows, not out of the code. This file exists so a fresh install has a
 * COMPLETE business to look at and talk to, instead of four placeholder answers
 * that teach nobody anything. Replacing it is a database edit, not a code change:
 * AI yordamchi -> Biznes profili / Bilim bazasi.
 *
 * Everything here is taken from AviLab's own site. Where the site does not state
 * something - prices, delivery times, opening hours, guarantees - it is left out
 * on purpose rather than filled in with a plausible number. The agent may only
 * repeat what is written here, so an invented figure would become something the
 * business gets held to on a recorded line.
 */
import type { UnknownAnswerPolicy } from "@/db/schema";

export interface SeedOperator {
	fullName: string;
	role: string;
	extension: string;
	/** Internal login identity. Deliberately synthetic, built from the extension. */
	phone: string;
	email: string;
	userRole: "supervisor" | "manager";
}

export const AVILAB_PROFILE = {
	businessName: "AviLab",
	industry: "Dasturiy ta'minot va sun'iy intellekt studiyasi",
	businessDescription:
		"AviLab — zamonaviy bizneslar uchun AI tizimlari, veb-saytlar, mobil ilovalar, " +
		"korporativ platformalar va raqamli mahsulotlar yaratadigan studiya. Bosh ofis " +
		"Urganchda, jamoa xalqaro va asosan async ishlaydi. Yuz yigirmadan ortiq loyiha " +
		"yetkazilgan, o'n sakkizdan ortiq mamlakatda ellikdan ortiq mijoz bilan ishlangan.",
	language: "uz",
	additionalLanguages: ["ru", "en"],
	/**
	 * A GEMINI voice, because AI_VOICE_PROVIDER=gemini.
	 *
	 * This one field is provider-specific and the two vendors share no names.
	 * Gemini takes Aoede, Autonoe, Callirrhoe, Charon, Despina, Enceladus,
	 * Erinome, Fenrir, Kore, Laomedeia, Leda, Orus, Puck, Umbriel or Zephyr;
	 * OpenAI takes alloy, ash, ballad, cedar, coral, echo, marin, sage, shimmer
	 * or verse. Switching provider means changing this too - the Gemini side
	 * falls back to its default and warns rather than dropping the call, but the
	 * business would be answering in a voice nobody chose.
	 */
	voice: "Callirrhoe",
	// No organisation name, by the owner's instruction: the caller is greeted by a
	// person, not by a company announcement. buildGreeting only appends the open
	// question to a greeting it generated itself, so this one ends with its own -
	// otherwise the caller hears a statement and then silence.
	greeting: "Assalomu alaykum! Eshitaman sizni, qanday yordam bera olaman?",
	recordingNotice: "Suhbat sifat nazorati uchun yozib olinadi.",
	customInstructions:
		"Siz dasturiy ta'minot studiyasining birinchi aloqa nuqtasisiz. Qo'ng'iroq qiluvchi " +
		"ko'pincha loyihasi haqida gapirmoqchi bo'ladi: nima qurmoqchi, qanday muammoni " +
		"hal qilmoqchi. Uni bo'lmang va texnik atamalar bilan bosmang.\n" +
		// Deliberately no "which organisation are you calling for". It made every
		// caller answer a question that only fits a B2B lead form, and most people
		// ringing are just people. The name is either already on file - the prompt
		// is told when it is - or asked for plainly, once.
		"Har bir murojaatda shu ikkitasini aniqlang: qanday mahsulot yoki xizmat kerak, " +
		"va kim gapiryapti. Agar raqam bazada bo'lsa, ismni so'ramang — o'shani ishlating. " +
		"Bo'lmasa, faqat ismini so'rang. Qaysi tashkilot nomidan qo'ng'iroq qilayotganini " +
		"HECH QACHON so'ramang; mijozning o'zi aytsa, yozib oling. " +
		"Shulardan keyin murojaatni yozib oling.\n" +
		"Narx, muddat va shartnoma shartlari haqida hech qachon o'zingizdan gapirmang — " +
		"bu har bir loyihada boshqacha. Talabni yozib olib, mutaxassis bog'lanishini ayting.\n" +
		"MUHIM: qaysi tashkilot nomidan gapirayotganingizni AYTMANG. Kompaniya nomini " +
		"o'zingiz tilga olmang — na salomlashishda, na suhbat o'rtasida, na xayrlashishda. " +
		'Mijozning o\'zi so\'rasa ("qayerdansiz?", "qaysi kompaniya?"), o\'sha paytda ayting; ' +
		'boshqa hech qachon aytmang. "Biz", "bizda", "jamoamiz" deb gapiring.',
	// Twelve categories, one per service the studio sells plus two catch-alls, so a
	// registered request lands in front of the right person without a triage step.
	ticketCategories: [
		"AI ishlab chiqish",
		"Veb ishlab chiqish",
		"Mobil ilova",
		"UI/UX dizayn",
		"CRM va ERP",
		"Telegram bot",
		"SaaS platforma",
		"Bulut va DevOps",
		"Kiberxavfsizlik",
		"Brending va motion",
		"Hamkorlik taklifi",
		"Boshqa",
	],
	/**
	 * take_message, not transfer.
	 *
	 * The team is international and async - "kerak bo'lganda oflayn" - so a caller
	 * who asks something the knowledge base does not cover is far more likely to be
	 * helped by a written request that reaches the right engineer than by a transfer
	 * to whoever happens to be at a desk. Transfer stays available: the agent still
	 * uses it whenever the caller actually asks for a person.
	 */
	unknownPolicy: "take_message" as UnknownAnswerPolicy,
	transferExtensions: ["101", "102", "103", "104"],
	/**
	 * Null on purpose: AviLab's site publishes no opening hours, and an agent that
	 * invents them would be telling callers when to ring back on a recorded line.
	 */
	businessHours: null,
	afterHoursMessage: null,
	maxCallSeconds: 900,
	silenceHangupMs: 20_000,
} as const;

/**
 * The four team members a caller can actually be put through to.
 *
 * AviLab has seven people; only four PJSIP endpoints exist (101-104), so the
 * extensions go to the roles a first-time caller needs: the founder for scope and
 * commercial questions, a full-stack engineer for build questions, the MLOps lead
 * for AI questions, and marketing for everything else. The remaining three are
 * described in the knowledge base but take no calls.
 */
export const AVILAB_OPERATORS: SeedOperator[] = [
	{
		fullName: "Abdurasulov Abdulla",
		role: "Founder & Data Scientist",
		extension: "101",
		phone: "+998900000101",
		email: "abdulla@avilab.uz",
		userRole: "supervisor",
	},
	{
		fullName: "Akbar Satipov",
		role: "Full Stack developer",
		extension: "102",
		phone: "+998900000102",
		email: "akbar@avilab.uz",
		userRole: "manager",
	},
	{
		fullName: "Azizbek Atoyev",
		role: "Data Scientist & MLOps Engineer",
		extension: "103",
		phone: "+998900000103",
		email: "azizbek@avilab.uz",
		userRole: "manager",
	},
	{
		fullName: "Shaxriyor Davlatnazarov",
		role: "Marketolog",
		extension: "104",
		phone: "+998900000104",
		email: "shaxriyor@avilab.uz",
		userRole: "manager",
	},
];
