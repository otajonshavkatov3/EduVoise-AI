/**
 * Knowledge base retrieval — what the agent is allowed to tell a caller.
 *
 * The agent answers business questions ("qachon ochiqsiz?", "narxi qancha?")
 * from these entries. Anything not in here it must NOT invent: a made-up price
 * or address on a recorded phone line is a real liability for the business
 * owner, so the prompt is built to refuse and the unknown-policy decides what
 * happens instead.
 *
 * Retrieval is deliberately plain SQL scoring rather than embeddings:
 *   - no extra service, no API cost, no dimension drift on every model change
 *   - Postgres has no Uzbek stemmer, so tsvector buys little over token matching
 *   - a business FAQ is tens to hundreds of rows, where this is instant
 * If a customer ever outgrows it, swap this one module for a vector store; the
 * interface is the only thing the rest of the system depends on.
 *
 * Three properties of Uzbek phone speech shape everything below, and getting any
 * of them wrong makes the agent answer the wrong question out loud:
 *
 *  1. Uzbek is agglutinative. The caller says "narxlaringiz", the entry says
 *     "narxi". Matching the caller's whole word against the stored text (the old
 *     `question ILIKE '%narxlaringiz%'`) is the wrong direction and finds
 *     nothing, so every suffix a caller adds used to lose the answer. Tokens are
 *     therefore stemmed and matched as a WORD PREFIX in both directions.
 *  2. The apostrophe in o'/g'/ma'lumot has five codepoints in the wild (typed
 *     ASCII, the two modern Uzbek letters, two curly quotes) and speech-to-text
 *     picks whichever it likes. All of them, plus their absence, are folded away
 *     on both sides before anything is compared.
 *  3. Uzbek questions end in grammatical filler — "…berasizmi", "…bo'ladimi",
 *     "…qilasizmi". Those words appear in half the knowledge base, so scoring
 *     them like topic words made any polite question retrieve four unrelated
 *     entries with full confidence. Every token is therefore weighted by how
 *     RARE it is in this tenant's own knowledge base (document frequency), and a
 *     result has to clear a minimum score to count as found at all. Returning
 *     nothing is the correct, safe answer: the caller gets the unknown-policy.
 */
import { asc, desc, eq, sql } from "drizzle-orm";
import pino from "pino";
import pretty from "pino-pretty";

import { db } from "@/db";
import { knowledgeBaseEntries } from "@/db/schema";
import { type TenantId, tenantWhere } from "@/lib/tenancy";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{ level: isProduction ? "info" : "debug" },
	isProduction ? undefined : pretty({ colorize: true })
).child({ module: "ai-agent:knowledge" });

export interface KnowledgeHit {
	id: string;
	question: string;
	answer: string;
	tags: string[];
	priority: number;
	score: number;
}

/**
 * Every apostrophe a caller, a keyboard or a transcription can produce for
 * o'/g'/ma'lumot: ASCII, the two modern Uzbek letters (U+02BB/U+02BC), both
 * curly quotes, plus the accent and backtick people type when they cannot find
 * the right key. They are DELETED rather than unified, so "to'lov", "toʻlov"
 * and "tolov" all become the same token.
 */
const APOSTROPHES = "'ʻʼ‘’´`";

/** Postgres' lower() is ASCII-only under the C collation this database uses. */
const CYRILLIC_UPPER = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
const CYRILLIC_LOWER = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя";

/**
 * What counts as "inside a word" for the boundary anchors.
 *
 * Postgres' own \m / \y anchors are locale-dependent and this database is
 * initialised with LC_COLLATE=C, where Cyrillic letters are not word
 * constituents — a Russian query would silently match nothing. Spelling the
 * class out keeps the pattern identical in Postgres and in JavaScript.
 */
const WORD_CHARS = "0-9a-zа-яё";

/** Below this a token is a syllable, not a word. Kept at 2 for AI, UI, UX, 1C. */
const MIN_TOKEN_LENGTH = 2;

/** Tokens this short are matched whole; a 2-letter prefix would match anything. */
const EXACT_MATCH_MAX_LENGTH = 2;

/** Never strip a word down past this — "narxi" may lose its "i", "ish" nothing. */
const MIN_STEM_LENGTH = 4;

/**
 * Stems are truncated to this before matching.
 *
 * It absorbs the consonant alternations a suffix list cannot: xavfsizlik →
 * xavfsizligi swaps k for g, so only a shared prefix finds both. Six characters
 * is long enough that unrelated words rarely collide, and anything that does
 * collide is common by definition and gets demoted by document frequency.
 */
const MAX_STEM_LENGTH = 6;

/** More than 12 tokens is a monologue, not a question; the rest add only noise. */
const MAX_TOKENS = 12;

/**
 * Uzbek noun and verb endings, plus the Russian ones a bilingual caller uses.
 *
 * The list only has to get the caller CLOSE to the stored root: what follows is
 * a prefix match, so stripping one suffix too many still finds the entry, while
 * stripping one too few loses it. Erring long is therefore the safe direction.
 * Sorted by length below, so a longer ending is always tried before the shorter
 * one hiding inside it.
 */
const RAW_SUFFIXES = [
	"laringizni",
	"laringizga",
	"laringizdan",
	"laringizda",
	"larimizni",
	"moqchiman",
	"moqchimiz",
	"ganmisiz",
	"laringiz",
	"larimiz",
	"larining",
	"ingizdan",
	"ingizni",
	"ingizga",
	"ingizda",
	"adigan",
	"idigan",
	"yotgan",
	"sizlar",
	"moqchi",
	"yapman",
	"yapmiz",
	"yapsiz",
	"lardan",
	"lardagi",
	"gansiz",
	"asizmi",
	"ysizmi",
	"ingiz",
	"imizni",
	"larni",
	"larga",
	"larda",
	"lari",
	"larim",
	"laring",
	"sizmi",
	"ganmi",
	"nikida",
	"gacha",
	"imiz",
	"ining",
	"niki",
	"dagi",
	"asiz",
	"ysiz",
	"aman",
	"amiz",
	"yapti",
	"ning",
	"ibdi",
	"lar",
	"dan",
	"gan",
	"kan",
	"ing",
	"miz",
	"siz",
	"ini",
	"ni",
	"ga",
	"ka",
	"qa",
	"da",
	"si",
	"im",
	"iz",
	"di",
	"ib",
	"sa",
	"mi",
	"i",
	// Russian, for the ru the profile advertises: офиса -> офис, сроки -> срок.
	"ами",
	"ями",
	"ого",
	"его",
	"ыми",
	"ими",
	"ов",
	"ев",
	"ей",
	"ая",
	"ое",
	"ые",
	"ый",
	"ий",
	"ой",
	"ом",
	"ем",
	"ах",
	"ях",
	"ию",
	"ия",
	"ие",
	"а",
	"е",
	"и",
	"о",
	"у",
	"ы",
	"я",
	"ю",
];

const SUFFIXES = [...RAW_SUFFIXES].sort((a, b) => b.length - a.length);

/**
 * Words that carry no topic at all.
 *
 * Deliberately short: document frequency already demotes whatever is common in
 * a given knowledge base, and that adapts to the business. This list only
 * removes words that are noise in EVERY business, so they never reach the
 * document-frequency pass.
 */
const STOP_WORDS = new Set([
	"men",
	"siz",
	"sizlar",
	"biz",
	"uchun",
	"ham",
	"bilan",
	"lekin",
	"yoki",
	"qanday",
	"qanaqa",
	"qancha",
	"nima",
	"bormi",
	"kerak",
	"iltimos",
	"salom",
	"assalomu",
	"alaykum",
	"rahmat",
	"mumkin",
	"mayli",
	"это",
	"как",
	"что",
	"для",
	"или",
	"есть",
	"пожалуйста",
	"здравствуйте",
	"the",
	"and",
	"for",
	"you",
	"your",
	"can",
	"please",
	"hello",
]);

/**
 * Scoring weights.
 *
 * A tag is the owner's explicit statement of what an entry is ABOUT, so it
 * outranks a word that happens to appear in someone else's question; an answer
 * hit is weak evidence on its own — a single one cannot reach MIN_HIT_SCORE.
 */
export const FIELD_WEIGHT = { question: 3, tags: 4, answer: 1 } as const;

/** Token weights, on a x10 scale so the exposed score stays an integer. */
const TERM_WEIGHT_FULL = 10;
const TERM_WEIGHT_WEAK = 3;

/** A token in more than this share of the entries says nothing about which one. */
const NOISE_DF_RATIO = 0.3;
/** Common but not meaningless: it can break a tie, it cannot make a hit alone. */
const WEAK_DF_RATIO = 0.15;

/** Below this many entries the ratios above are noise themselves, so nothing is demoted. */
const DF_STATS_MIN_ENTRIES = 12;

/**
 * One informative word found in a question (3 x 10) or a tag (4 x 10).
 *
 * This is the found/not-found line, and it is the main defence against the
 * agent answering a question the business never covered: everything below it is
 * an incidental word match, and the caller is better served by the unknown
 * policy than by a confident answer from an unrelated entry.
 *
 * Demanding two independent signals instead (40) was measured on the seeded
 * tenant: it drops the false-positive rate on questions this business cannot
 * answer from 50% to 25%, but it also loses "siz kimsiz", "bo'lib to'lash
 * imkoniyati bormi" and "ishni qanday bosqichlarda olib borasiz" — three
 * questions callers really do ask, each carried by a single word. One rare word
 * in the right place is genuine evidence, so the line stays here.
 */
const MIN_HIT_SCORE = 30;

/**
 * …unless the caller gave us nothing better to work with.
 *
 * A one-word question made of a word that is common in this knowledge base
 * ("jamoa", or "sayt" at a web studio) can never reach MIN_HIT_SCORE, and
 * silence is the wrong answer to a question whose topic is perfectly clear. So
 * when the whole query is one or two words and the knowledge base knows every
 * one of them, half of the best score the query could possibly produce is
 * enough. The moment a word is missing from the knowledge base the strict line
 * comes back, because a missing word is evidence the topic is not covered.
 */
const MIN_HIT_COVERAGE = 0.5;
const MAX_RELAXED_TOKENS = 2;

/**
 * A hit far behind the best one is a passenger; the model should not see it.
 *
 * Applied only from the SECOND result onwards. Applying it to the whole list
 * discarded entries that had already cleared the found/not-found line: one
 * strong three-field match scores high enough that 40% of it lands above a
 * perfectly good single-field match on the same rare word, so a question with
 * two legitimate answers came back with one. The threshold decides whether an
 * entry is relevant at all; this only decides how much company the winner keeps.
 */
const TAIL_SCORE_RATIO = 0.4;

/** A query token reduced to what the database is actually matched against. */
export interface SearchTerm {
	/** The normalised word as the caller said it. */
	token: string;
	/** Its root, after suffix stripping and truncation. */
	stem: string;
	/** POSIX pattern; valid and identical in both Postgres and JavaScript. */
	pattern: string;
	/** x10 weight from document frequency; 0 means the token is ignored. */
	weight: number;
	/** How many active entries in this profile contain the term. */
	documentFrequency: number;
}

/**
 * Fold away everything that is written more than one way.
 *
 * Applied to the caller's query here and to the stored columns in SQL, so both
 * sides of every comparison are in the same alphabet.
 */
export function normalizeForSearch(text: string): string {
	let out = text.toLowerCase();

	for (const apostrophe of APOSTROPHES) {
		out = out.replaceAll(apostrophe, "");
	}

	return out;
}

/** Strip Uzbek inflection, then truncate to a prefix short enough to survive it. */
export function stemToken(token: string): string {
	let stem = token;

	// Two rounds: "narxlaringizni" is plural + possessive + case in one word.
	for (let round = 0; round < 2; round++) {
		const suffix = SUFFIXES.find(
			(candidate) => stem.length - candidate.length >= MIN_STEM_LENGTH && stem.endsWith(candidate)
		);

		if (suffix === undefined) {
			break;
		}

		stem = stem.slice(0, -suffix.length);
	}

	return stem.slice(0, MAX_STEM_LENGTH);
}

/**
 * The regex a stem is matched with.
 *
 * A prefix match with a leading word boundary, so "narx" finds "narxi" and
 * "narxlari" but "ish" no longer finds "uchrash-ish" or "k-ish-i". Two-letter
 * tokens are matched whole instead: "ai" as a prefix would hit any word
 * starting with those letters.
 */
export function termPattern(stem: string): string {
	const boundary = `(^|[^${WORD_CHARS}])`;

	return stem.length <= EXACT_MATCH_MAX_LENGTH
		? `${boundary}${stem}([^${WORD_CHARS}]|$)`
		: `${boundary}${stem}`;
}

/** Split a caller's question into the words worth matching on. */
export function tokenize(query: string): string[] {
	const words = normalizeForSearch(query)
		.split(new RegExp(`[^${WORD_CHARS}]+`, "u"))
		.filter((word) => word.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(word));

	return [...new Set(words)].slice(0, MAX_TOKENS);
}

/**
 * How much a token is worth, given how many entries contain it.
 *
 * "berasizmi" is in half the knowledge base and says nothing about which entry
 * the caller wants; "kiberxavfsizlik" is in one and says everything. The ratios
 * are measured per tenant rather than hardcoded, because what is generic
 * depends entirely on the business — "sayt" is noise for a web studio and a
 * strong signal for a dentist.
 */
export function termWeight(documentFrequency: number, totalEntries: number): number {
	if (documentFrequency === 0) {
		return 0;
	}

	if (totalEntries < DF_STATS_MIN_ENTRIES) {
		return TERM_WEIGHT_FULL;
	}

	const ratio = documentFrequency / totalEntries;

	if (ratio > NOISE_DF_RATIO) {
		return 0;
	}

	return ratio > WEAK_DF_RATIO ? TERM_WEIGHT_WEAK : TERM_WEIGHT_FULL;
}

/**
 * The score a result must reach to count as found.
 *
 * `tokenCount` is how many words the caller actually used, before the ones this
 * knowledge base has never heard of were dropped — see MIN_HIT_COVERAGE.
 */
export function hitThreshold(terms: SearchTerm[], tokenCount: number): number {
	if (terms.length !== tokenCount || tokenCount > MAX_RELAXED_TOKENS) {
		return MIN_HIT_SCORE;
	}

	const fieldTotal = FIELD_WEIGHT.question + FIELD_WEIGHT.tags + FIELD_WEIGHT.answer;
	const best = terms.reduce((sum, term) => sum + term.weight * fieldTotal, 0);

	return Math.min(MIN_HIT_SCORE, Math.round(best * MIN_HIT_COVERAGE));
}

/** lower() + apostrophe folding + Cyrillic case folding, matching normalizeForSearch. */
function normalizedColumn(column: unknown): ReturnType<typeof sql> {
	return sql`translate(translate(lower(coalesce(${column}, '')), ${CYRILLIC_UPPER}, ${CYRILLIC_LOWER}), ${APOSTROPHES}, '')`;
}

const NORMALIZED_QUESTION = normalizedColumn(knowledgeBaseEntries.question);
const NORMALIZED_ANSWER = normalizedColumn(knowledgeBaseEntries.answer);
const NORMALIZED_TAGS = normalizedColumn(sql`${knowledgeBaseEntries.tags}::text`);

/**
 * Whose knowledge base, and which profile inside it.
 *
 * The tenant is named EVEN THOUGH agent_profile_id already implies it. Two
 * reasons, and neither is tidiness: the entries are the sentences the agent says
 * out loud to a stranger, so a profile id arriving from somewhere the caller
 * controls must not be able to make one business answer with another's prices;
 * and the tenant-leading form is what `idx_kb_tenant_profile`
 * (tenant_id, agent_profile_id, is_active) is built for.
 */
function profileFilter(tenantId: TenantId, profileId: string) {
	return tenantWhere(
		knowledgeBaseEntries,
		tenantId,
		eq(knowledgeBaseEntries.agentProfileId, profileId),
		eq(knowledgeBaseEntries.isActive, true)
	);
}

/**
 * How common each token is in this profile's entries.
 *
 * A separate pass on purpose: the weights it produces are what makes the score
 * meaningful, and computing them in TypeScript keeps the rule readable and unit
 * testable instead of buried in a window function.
 */
export function buildDocumentFrequencyQuery(
	tenantId: TenantId,
	profileId: string,
	patterns: string[]
) {
	const counters = sql.join(
		patterns.map(
			(pattern, i) =>
				sql`count(*) FILTER (WHERE haystack ~ ${pattern})::int AS ${sql.raw(`df_${i}`)}`
		),
		sql`, `
	);

	return sql`
		SELECT count(*)::int AS total, ${counters}
		FROM (
			SELECT ${NORMALIZED_QUESTION} || ' ' || ${NORMALIZED_ANSWER} || ' ' || ${NORMALIZED_TAGS} AS haystack
			FROM ${knowledgeBaseEntries}
			WHERE ${profileFilter(tenantId, profileId)}
		) entries
	`;
}

/** The weighted score, as one plain SQL query. */
export function buildScoreQuery(
	tenantId: TenantId,
	profileId: string,
	terms: SearchTerm[],
	limit: number
) {
	const scoreExpr = sql.join(
		terms.map(
			(term) => sql`${term.weight} * (
				CASE WHEN question_text ~ ${term.pattern} THEN ${FIELD_WEIGHT.question} ELSE 0 END
				+ CASE WHEN tags_text ~ ${term.pattern} THEN ${FIELD_WEIGHT.tags} ELSE 0 END
				+ CASE WHEN answer_text ~ ${term.pattern} THEN ${FIELD_WEIGHT.answer} ELSE 0 END
			)`
		),
		sql` + `
	);

	return sql`
		SELECT id, question, answer, tags, priority, (${scoreExpr})::int AS "matchScore"
		FROM (
			SELECT
				${knowledgeBaseEntries.id} AS id,
				${knowledgeBaseEntries.question} AS question,
				${knowledgeBaseEntries.answer} AS answer,
				${knowledgeBaseEntries.tags} AS tags,
				${knowledgeBaseEntries.priority} AS priority,
				${NORMALIZED_QUESTION} AS question_text,
				${NORMALIZED_ANSWER} AS answer_text,
				${NORMALIZED_TAGS} AS tags_text
			FROM ${knowledgeBaseEntries}
			WHERE ${profileFilter(tenantId, profileId)}
		) entries
		ORDER BY "matchScore" DESC, priority DESC, id ASC
		LIMIT ${limit}
	`;
}

interface ScoreRow extends Record<string, unknown> {
	id: string;
	question: string;
	answer: string;
	tags: string[] | null;
	priority: number;
	matchScore: number;
}

/**
 * Best-matching entries for a caller's question.
 *
 * Returns an empty list far more readily than it used to: a question this
 * business has never answered must reach the unknown policy, not an entry that
 * happened to share the word "berasizmi".
 */
export async function searchKnowledgeBase(
	tenantId: TenantId,
	profileId: string,
	query: string,
	limit = 5
): Promise<KnowledgeHit[]> {
	const tokens = tokenize(query);

	if (tokens.length === 0) {
		return [];
	}

	const stems = tokens.map(stemToken);
	const patterns = stems.map(termPattern);

	try {
		const frequencies = await db.execute<Record<string, number>>(
			buildDocumentFrequencyQuery(tenantId, profileId, patterns)
		);
		const stats = frequencies.rows[0];

		if (stats === undefined || Number(stats.total) === 0) {
			return [];
		}

		const total = Number(stats.total);
		const terms: SearchTerm[] = tokens
			.map((token, i) => {
				const documentFrequency = Number(stats[`df_${i}`] ?? 0);

				return {
					token,
					stem: stems[i],
					pattern: patterns[i],
					weight: termWeight(documentFrequency, total),
					documentFrequency,
				};
			})
			.filter((term) => term.weight > 0);

		// Every word the caller used is either absent from the knowledge base or
		// present in most of it. Either way nothing here distinguishes one entry.
		if (terms.length === 0) {
			logger.debug({ query, tokens }, "knowledge base search: no informative token");
			return [];
		}

		const scored = await db.execute<ScoreRow>(buildScoreQuery(tenantId, profileId, terms, limit));
		const threshold = hitThreshold(terms, tokens.length);
		const best = Number(scored.rows[0]?.matchScore ?? 0);
		const tailFloor = best * TAIL_SCORE_RATIO;

		const hits = scored.rows
			.filter((row, index) => {
				const score = Number(row.matchScore);

				// The relevance line applies to everything; the tail rule only trims the
				// company the winner keeps, so the best hit can never be filtered out by
				// its own score and a genuine second answer is not lost to a strong first.
				return score >= threshold && (index === 0 || score >= tailFloor);
			})
			.map((row) => ({
				id: row.id,
				question: row.question,
				answer: row.answer,
				tags: row.tags ?? [],
				priority: Number(row.priority),
				score: Number(row.matchScore),
			}));

		if (hits.length > 0) {
			// Deliberately not awaited: a live phone call must not wait on a counter
			// update. recordUsage swallows its own errors, so the catch is only here
			// to keep the promise from floating.
			recordUsage(tenantId, hits[0].id).catch(() => {
				// already logged inside recordUsage
			});
		}

		logger.debug(
			{ query, terms: terms.map((t) => `${t.stem}:${t.documentFrequency}`), hits: hits.length },
			"knowledge base search"
		);

		return hits;
	} catch (err) {
		// A failed lookup must not break the call; the agent falls back to its
		// unknown-policy exactly as if nothing matched.
		logger.error({ err, query }, "knowledge base search failed");
		return [];
	}
}

/**
 * Usage counters, so the owner can see which answers callers actually need.
 *
 * Only the best hit is counted. Counting all four made the counter measure how
 * often an entry was dragged along by a shared word, and since it is also the
 * tie-break for the primed set, the entries that won the most accidental
 * matches were the ones that climbed into the prompt.
 */
async function recordUsage(tenantId: TenantId, id: string): Promise<void> {
	try {
		await db
			.update(knowledgeBaseEntries)
			.set({
				useCount: sql`${knowledgeBaseEntries.useCount} + 1`,
				lastUsedAt: new Date(),
			})
			// The id came from a search that was already tenant-filtered, so the tenant
			// term cannot change which row is hit. It is here because an UPDATE that
			// identifies its row by id alone is one refactor away from being called with
			// an id from somewhere else, and this is a write.
			.where(tenantWhere(knowledgeBaseEntries, tenantId, eq(knowledgeBaseEntries.id, id)));
	} catch (err) {
		logger.debug({ err }, "could not record knowledge base usage");
	}
}

/**
 * The highest-value entries, injected into the system prompt up front so common
 * questions are answered without a tool round-trip (which costs ~a second of
 * dead air on a phone call).
 *
 * The id is the final sort key for a reason: priority and use_count tie for
 * whole bands of entries, and without it Postgres was free to return them in
 * heap order — a business fact drifted in and out of the agent's prompt between
 * two calls on identical data.
 */
export async function getPrimedEntries(
	tenantId: TenantId,
	profileId: string,
	limit = 12
): Promise<KnowledgeHit[]> {
	try {
		const rows = await db
			.select({
				id: knowledgeBaseEntries.id,
				question: knowledgeBaseEntries.question,
				answer: knowledgeBaseEntries.answer,
				tags: knowledgeBaseEntries.tags,
				priority: knowledgeBaseEntries.priority,
			})
			.from(knowledgeBaseEntries)
			.where(profileFilter(tenantId, profileId))
			.orderBy(
				desc(knowledgeBaseEntries.priority),
				desc(knowledgeBaseEntries.useCount),
				asc(knowledgeBaseEntries.id)
			)
			.limit(limit);

		return rows.map((r) => ({
			id: r.id,
			question: r.question,
			answer: r.answer,
			tags: r.tags ?? [],
			priority: r.priority,
			score: 0,
		}));
	} catch (err) {
		logger.error({ err }, "could not load primed knowledge entries");
		return [];
	}
}

/** Compact block for the system prompt. Kept terse: prompt tokens are per-call cost. */
export function formatEntriesForPrompt(entries: KnowledgeHit[]): string {
	if (entries.length === 0) {
		return "";
	}

	return entries
		.map((e, i) => `${i + 1}. S: ${e.question.trim()}\n   J: ${e.answer.trim()}`)
		.join("\n");
}
