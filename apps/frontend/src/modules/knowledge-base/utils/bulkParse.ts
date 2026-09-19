import type { BulkEntryInput } from "../types";

export interface ParsedBulkRow {
	/** Matndagi qator raqami — xatoni topish uchun. */
	line: number;
	question: string;
	answer: string;
	tags: string[];
	error: string | null;
}

export interface BulkParseResult {
	rows: ParsedBulkRow[];
	validRows: ParsedBulkRow[];
	invalidCount: number;
}

/**
 * "savol | javob" qatorlarini o'qiydi.
 *
 * Uchinchi ustun ixtiyoriy: "savol | javob | teg1, teg2".
 * Har bir qator alohida tekshiriladi va xatosi o'zi bilan qaytadi — import
 * qilishdan oldin biznes egasi nima ketayotganini ko'rib turishi kerak.
 */
export function parseBulkInput(text: string): BulkParseResult {
	const rows: ParsedBulkRow[] = [];
	const seen = new Set<string>();
	const lines = text.split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = (lines[index] ?? "").trim();

		if (trimmed.length === 0) {
			continue;
		}

		const row = parseLine(trimmed, index + 1, seen);

		if (row.error === null) {
			seen.add(row.question.toLowerCase());
		}

		rows.push(row);
	}

	const validRows = rows.filter((row) => row.error === null);

	return {
		rows,
		validRows,
		invalidCount: rows.length - validRows.length,
	};
}

/** Bitta qator. `seen` — shu importda allaqachon uchragan savollar. */
function parseLine(trimmed: string, line: number, seen: Set<string>): ParsedBulkRow {
	const parts = trimmed.split("|");

	if (parts.length < 2) {
		return {
			line,
			question: trimmed,
			answer: "",
			tags: [],
			error: "«|» belgisi yo'q — format: savol | javob",
		};
	}

	const question = (parts[0] ?? "").trim();
	const answer = (parts[1] ?? "").trim();

	if (parts.length > 3) {
		return {
			line,
			question,
			answer,
			tags: [],
			error: "«|» belgisi juda ko'p — ko'pi bilan: savol | javob | teglar",
		};
	}

	const tags = (parts[2] ?? "")
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0)
		.slice(0, 10);

	return { line, question, answer, tags, error: lineError(question, answer, tags, seen) };
}

/**
 * Tekshiruvlar server sxemasi bilan bir xil bo'lishi kerak
 * (`knowledge-base.schemas.ts`): aks holda qator yashil «Tayyor» bo'lib turadi,
 * import esa uni jimgina rad etadi.
 */
const MIN_QUESTION_LENGTH = 3;
const MAX_TAG_LENGTH = 40;

function lineError(
	question: string,
	answer: string,
	tags: string[],
	seen: Set<string>
): string | null {
	if (question.length === 0) {
		return "Savol bo'sh";
	}
	if (question.length < MIN_QUESTION_LENGTH) {
		return `Savol juda qisqa (kamida ${MIN_QUESTION_LENGTH} belgi)`;
	}
	if (answer.length === 0) {
		return "Javob bo'sh — AI aytadigan matn kerak";
	}
	if (question.length > 500) {
		return "Savol juda uzun (500 belgidan ko'p)";
	}
	if (answer.length > 2000) {
		return "Javob juda uzun (2000 belgidan ko'p)";
	}
	if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
		return `Teg juda uzun (${MAX_TAG_LENGTH} belgidan ko'p)`;
	}
	if (seen.has(question.toLowerCase())) {
		return "Bu savol shu ro'yxatda takrorlanadi";
	}

	return null;
}

export function toBulkPayload(rows: ParsedBulkRow[]): BulkEntryInput[] {
	return rows.map((row) => ({
		question: row.question,
		answer: row.answer,
		tags: row.tags.length > 0 ? row.tags : undefined,
	}));
}
