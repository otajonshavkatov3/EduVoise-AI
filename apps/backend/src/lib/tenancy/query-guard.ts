/**
 * A ratchet over the 148 query sites.
 *
 * WHY THIS EXISTS. The type checker catches every WRITE that forgets a tenant -
 * tenant_id is NOT NULL, so an insert without one does not compile. It cannot catch
 * a READ: `db.select().from(calls).where(eq(calls.id, id))` is perfectly typed and
 * returns another customer's call. There are around a hundred such sites, they are
 * being rewritten by later phases, and "we will remember to scope them all" is not
 * a plan - it is the exact assumption that ends the business in its first week.
 *
 * So this module counts them. It scans the source for database access to a
 * tenant-scoped table and reports every statement that does not mention a tenant.
 * The test next door compares that count against a committed baseline and fails
 * when it GOES UP. Today the number is what it is; what it can never be again is
 * larger. As phases two to four rewrite the query sites, the baseline comes down
 * with them, and the day it reaches zero the ratchet becomes an absolute rule.
 *
 * WHAT IT CANNOT DO, stated plainly because a guard trusted beyond its evidence is
 * worse than none:
 *
 *   - It is textual. A statement that mentions a tenant SOMEWHERE counts as scoped,
 *     even if it filters on the wrong tenant, or takes the tenant from the request
 *     body instead of the token.
 *   - A join scoped on one table and unscoped on the other reads as scoped.
 *   - Raw db.execute(sql`...`) is reported by name only; nobody can check the
 *     semantics of a string from here.
 *
 * It catches the mistake it was built for: a new query site, or a rewritten one,
 * that has no tenant in it at all.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { allSchemaTables, isTenantScopedTable } from "./tables";

/** Everything the scanner will accept as evidence that a statement is scoped. */
const TENANT_MARKERS = [
	"tenantWhere",
	"tenantId",
	"tenant_id",
	"tenantIdOf",
	"currentTenantId",
] as const;

/** Files that are not query sites, or where an unscoped query is correct. */
const SKIPPED_PATH_PARTS = [
	// The tenancy library itself: it is what scoping is built from, and the tenants
	// table is the one table a query may legitimately not scope.
	`${join("lib", "tenancy")}`,
	// Seeds and one-off scripts run as the operator, against a database they are
	// setting up. They resolve the tenant explicitly (see db/seedTenants.ts).
	`${join("db", "seed")}`,
	`${join("db", "reset")}`,
	`${join("db", "migrations")}`,
] as const;

export interface UnscopedSite {
	/** Path relative to src/, with forward slashes. */
	file: string;
	line: number;
	/** The drizzle export name of the table, e.g. "callTranscripts". */
	table: string;
	/** How the table was reached: from / insert / update / delete / query. */
	kind: string;
	/** The line itself, trimmed, so a report can be acted on without opening the file. */
	text: string;
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);

		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			out.push(full);
		}
	}

	return out;
}

function isSkipped(relative: string): boolean {
	return SKIPPED_PATH_PARTS.some((part) => relative.includes(part));
}

/**
 * The statement a match sits in, approximately: from the previous `;` or `{` to the
 * next `;`. Approximate is enough - the question is only "does this statement
 * mention a tenant at all".
 */
function statementAround(source: string, index: number): string {
	let start = index;

	for (let i = index; i >= 0 && index - i < 2000; i -= 1) {
		const char = source[i];

		if (char === ";" || char === "{" || char === "}") {
			start = i + 1;
			break;
		}

		start = i;
	}

	let end = source.indexOf(";", index);

	if (end === -1 || end - index > 2000) {
		end = Math.min(source.length, index + 2000);
	}

	return source.slice(start, end);
}

function lineOf(source: string, index: number): number {
	let line = 1;

	for (let i = 0; i < index; i += 1) {
		if (source[i] === "\n") {
			line += 1;
		}
	}

	return line;
}

/** How a table can be reached in a drizzle query, and what to call each shape. */
function accessPatterns(table: string): { kind: string; needle: string }[] {
	return [
		{ kind: "from", needle: `.from(${table})` },
		{ kind: "insert", needle: `.insert(${table})` },
		{ kind: "update", needle: `.update(${table})` },
		{ kind: "delete", needle: `.delete(${table})` },
		{ kind: "query", needle: `.query.${table}.` },
		{ kind: "join", needle: `Join(${table},` },
	];
}

/** Every occurrence of one needle in one file whose statement names no tenant. */
function scanForNeedle(
	file: { relative: string; source: string },
	table: string,
	pattern: { kind: string; needle: string }
): UnscopedSite[] {
	const { relative, source } = file;
	const found: UnscopedSite[] = [];

	let index = source.indexOf(pattern.needle);

	while (index !== -1) {
		const statement = statementAround(source, index);

		if (!TENANT_MARKERS.some((marker) => statement.includes(marker))) {
			const line = lineOf(source, index);

			found.push({
				file: relative,
				line,
				table,
				kind: pattern.kind,
				text: (source.split("\n")[line - 1] ?? "").trim().slice(0, 160),
			});
		}

		index = source.indexOf(pattern.needle, index + pattern.needle.length);
	}

	return found;
}

/** The scan, over already-read sources. Separated so the test controls the I/O. */
export function scanSources(files: { relative: string; source: string }[]): UnscopedSite[] {
	const scopedTables = allSchemaTables()
		.filter((entry) => isTenantScopedTable(entry.table))
		.map((entry) => entry.name);

	const found: UnscopedSite[] = [];

	for (const file of files) {
		for (const table of scopedTables) {
			for (const pattern of accessPatterns(table)) {
				found.push(...scanForNeedle(file, table, pattern));
			}
		}
	}

	return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Files to scan, read from disk. */
export async function readSourceFiles(
	srcDir: string
): Promise<{ relative: string; source: string }[]> {
	const files: { relative: string; source: string }[] = [];

	for (const file of walk(srcDir)) {
		const relative = file.slice(srcDir.length + 1);

		if (isSkipped(relative)) {
			continue;
		}

		files.push({
			relative: relative.replaceAll("\\", "/"),
			source: await Bun.file(file).text(),
		});
	}

	return files;
}

/** Unscoped sites per file, which is what the baseline records. */
export function countByFile(sites: UnscopedSite[]): Record<string, number> {
	const counts: Record<string, number> = {};

	for (const site of sites) {
		counts[site.file] = (counts[site.file] ?? 0) + 1;
	}

	return counts;
}
