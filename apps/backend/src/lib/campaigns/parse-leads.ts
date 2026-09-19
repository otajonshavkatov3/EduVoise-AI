/**
 * Turning a paste into rows.
 *
 * The owner's list lives in a spreadsheet or in a message somebody forwarded. So
 * the import accepts one textarea of text and works out the shape itself, because
 * "export as CSV with these exact columns" is a requirement people fail, and a
 * failed import is a campaign that never runs.
 *
 * WHAT IT UNDERSTANDS
 *
 *   998901234567;Alisher;qarz=450000;sana=15-avgust
 *   998901234567,Alisher,450000,15-avgust
 *   998901234567 <tab> Alisher
 *   telefon;ism;qarz;sana          <- an optional header line, detected
 *   998901234567;Alisher;450000;15-avgust
 *
 * The first cell is always the phone number. With a header, every other column is
 * named by its header - and those names are what the campaign's purpose text can
 * reference, which is the whole point: a campaign where every call says the
 * identical sentence is a robocall, one that says "450 000 so'm" to the right
 * person is a follow-up. Without a header the second cell is the name and the rest
 * become var1, var2, ... unless the cell itself is written `key=value`.
 *
 * This module is deliberately pure: no database, no normalisation, no validation
 * beyond the shape. Whether a phone number is dialable is phone.ts's decision and
 * whether a row is a duplicate is the handler's, so both can be tested without a
 * paste and this can be tested without a database.
 */

/** Cell caps. A merge value is read out loud on a phone call, not stored as a document. */
const MAX_VARIABLE_NAME = 40;
const MAX_VARIABLE_VALUE = 200;
const MAX_VARIABLES_PER_ROW = 12;
const MAX_NAME_LENGTH = 150;
/** Raw cell length kept for the phone, generous enough for "+998 (90) 570-65-07". */
const MAX_PHONE_CELL = 40;

/** Header cells that mean "this column is the person's name". */
const NAME_HEADERS =
	/^(ism|ismi|name|fio|f\.i\.o|familiya|mijoz|mijoz nomi|to'liq ism|full ?name)$/i;

/** Header cells that mean "this column is the phone number" - accepted but never required. */
const PHONE_HEADERS = /^(tel|telefon|telefon raqami|raqam|phone|phone ?number|number|msisdn)$/i;

export type LeadDelimiter = "\t" | ";" | ",";

export interface ParsedLeadRow {
	/** 1-based line number in the pasted text, so the UI can point at the bad line. */
	line: number;
	/** The line as pasted, bounded, for showing next to a skip reason. */
	raw: string;
	/** The first cell, exactly as written. Normalisation happens later, in phone.ts. */
	phone: string;
	fullName: string | null;
	variables: Record<string, string>;
}

export interface ParsedLeadText {
	delimiter: LeadDelimiter;
	/** Column names when a header line was detected, null when the paste had none. */
	headers: string[] | null;
	rows: ParsedLeadRow[];
	/** Line numbers that held nothing usable, so the count in the UI adds up. */
	ignoredLines: number[];
	/** True when `maxRows` cut the paste short - the UI has to say so. */
	truncated: boolean;
}

/**
 * Which separator this paste uses.
 *
 * Tab first: a copy out of Excel is tab-separated and may well contain commas
 * inside a name or an address. Then semicolon, which is what a Windows Excel in a
 * comma-decimal locale writes. Comma last.
 */
function detectDelimiter(line: string): LeadDelimiter {
	if (line.includes("\t")) {
		return "\t";
	}

	if (line.includes(";")) {
		return ";";
	}

	return ",";
}

function splitCells(line: string, delimiter: LeadDelimiter): string[] {
	return line.split(delimiter).map((cell) => cell.trim());
}

/** How many digits a cell holds. The phone test, and the header test. */
function digitCount(value: string): number {
	return (value.match(/\d/g) ?? []).length;
}

/**
 * Is the first line a header rather than a lead?
 *
 * A header's first cell is a word ("telefon"), a lead's is a number. Three digits
 * is the threshold because the shortest thing this system can dial is a
 * three-digit extension, so anything with fewer digits than that is not a phone
 * number and the line has to be a header.
 */
function looksLikeHeader(cells: string[]): boolean {
	const first = cells[0] ?? "";

	if (PHONE_HEADERS.test(first)) {
		return true;
	}

	return digitCount(first) < 3;
}

function truncate(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function addVariable(target: Record<string, string>, name: string, value: string): void {
	const key = truncate(name.trim(), MAX_VARIABLE_NAME);

	if (key.length === 0 || value.length === 0) {
		return;
	}

	if (Object.keys(target).length >= MAX_VARIABLES_PER_ROW) {
		return;
	}

	target[key] = truncate(value, MAX_VARIABLE_VALUE);
}

/** What one non-empty cell after the phone turns out to be. */
type CellRole =
	| { kind: "name" }
	| { kind: "variable"; name: string; value: string }
	| { kind: "positional"; value: string };

/**
 * Classify one cell. Separated from the loop so the four rules read as four rules.
 *
 * A header names the column. Without one, `key=value` names itself, the second cell
 * is the name by convention, and anything after that is positional - which is what
 * lets a hand-written list carry meaningful merge fields with no header at all.
 */
function classifyCell(
	column: number,
	value: string,
	header: string | undefined,
	nameTaken: boolean
): CellRole {
	if (header !== undefined && header.length > 0) {
		if (NAME_HEADERS.test(header) && !nameTaken) {
			return { kind: "name" };
		}

		return { kind: "variable", name: header, value };
	}

	const equals = value.indexOf("=");

	if (equals > 0) {
		return {
			kind: "variable",
			name: value.slice(0, equals),
			value: value.slice(equals + 1).trim(),
		};
	}

	if (column === 1 && !nameTaken) {
		return { kind: "name" };
	}

	return { kind: "positional", value };
}

/** One data line into a row, given the header (or lack of one). */
function buildRow(
	line: number,
	raw: string,
	cells: string[],
	headers: string[] | null
): ParsedLeadRow {
	const variables: Record<string, string> = {};
	let fullName: string | null = null;
	let unnamedIndex = 0;

	for (let column = 1; column < cells.length; column += 1) {
		const value = cells[column] ?? "";

		if (value.length === 0) {
			continue;
		}

		const role = classifyCell(column, value, headers?.[column], fullName !== null);

		if (role.kind === "name") {
			fullName = truncate(value, MAX_NAME_LENGTH);
		} else if (role.kind === "variable") {
			addVariable(variables, role.name, role.value);
		} else {
			unnamedIndex += 1;
			addVariable(variables, `var${unnamedIndex}`, role.value);
		}
	}

	return {
		line,
		raw: truncate(raw, 300),
		phone: truncate(cells[0] ?? "", MAX_PHONE_CELL),
		fullName,
		variables,
	};
}

/**
 * Parse a pasted list. Never throws: an unusable line is reported, not fatal.
 *
 * `maxRows` bounds the work rather than rejecting the paste, because a 5000-line
 * list should import its first `maxRows` and say so, not fail entirely at the last
 * step of somebody's afternoon.
 */
export function parseLeadText(text: string, maxRows: number): ParsedLeadText {
	const lines = text.split(/\r?\n/);
	const rows: ParsedLeadRow[] = [];
	const ignoredLines: number[] = [];
	let delimiter: LeadDelimiter = ",";
	let headers: string[] | null = null;
	let sawFirstLine = false;
	let truncated = false;

	for (const [index, rawLine] of lines.entries()) {
		const line = index + 1;
		const trimmed = rawLine.trim();

		// "#" starts a comment so an owner can annotate their own list.
		if (trimmed.length === 0 || trimmed.startsWith("#")) {
			continue;
		}

		if (!sawFirstLine) {
			sawFirstLine = true;
			delimiter = detectDelimiter(trimmed);

			const cells = splitCells(trimmed, delimiter);

			if (looksLikeHeader(cells)) {
				headers = cells;
				continue;
			}
		}

		if (rows.length >= maxRows) {
			truncated = true;
			break;
		}

		const cells = splitCells(trimmed, delimiter);

		if ((cells[0] ?? "").length === 0) {
			ignoredLines.push(line);
			continue;
		}

		rows.push(buildRow(line, trimmed, cells, headers));
	}

	return { delimiter, headers, rows, ignoredLines, truncated };
}
