/**
 * Hisobotni haqiqiy faylga aylantirish. xlsx uchun exceljs (loyihada allaqachon
 * o'rnatilgan), csv uchun UTF-8 BOM bilan matn — Excel BOM'siz o'zbekcha
 * belgilarni buzib ko'rsatadi.
 */
import ExcelJS from "exceljs";

import { formatDateTime, formatUzPhone, NO_DATA_LABEL, toExcelDate } from "./reports.format";

/** Ustun turi katakcha formatini va CSV ko'rinishini belgilaydi. */
export type ReportCellKind = "text" | "number" | "decimal" | "phone" | "datetime";

export type ReportCellValue = string | number | Date | null;

export type ReportColumn<TRow> = {
	header: string;
	width: number;
	kind: ReportCellKind;
	value: (row: TRow) => ReportCellValue;
};

export type ReportKeyValue = {
	label: string;
	value: string;
};

export type ReportDocument<TRow> = {
	/** Fayl nomining asosi (kengaytmasiz, lotin harflar). */
	fileBaseName: string;
	sheetName: string;
	columns: ReportColumn<TRow>[];
	rows: TRow[];
	/** Yakuniy qatorning birinchi katagi, masalan "JAMI — 1234 qo'ng'iroq". */
	totalsLabel: string;
	/**
	 * Yakuniy qator — ustunlar bilan bir xil tartibda va uzunlikda. Birinchi
	 * element e'tiborga olinmaydi (uning o'rniga totalsLabel yoziladi). Ustun
	 * bo'yicha jamlanma ma'noga ega bo'lmasa null berilishi kerak, 0 emas.
	 */
	totalsRow: ReportCellValue[];
	/** Qo'llanilgan filtrlar, oraliq, kim yuklab oldi. */
	meta: ReportKeyValue[];
	/** Butun oraliq bo'yicha hisoblangan ko'rsatkichlar. */
	summary: ReportKeyValue[];
};

export type ExportFile = {
	fileName: string;
	contentType: string;
	/** xlsx — ikkilik bufer, csv — matn. */
	body: ArrayBuffer | string;
};

const HEADER_FILL = "FF2154B2";
const TOTALS_FILL = "FFF1F5F9";
const BORDER_COLOR = "FFE2E8F0";
const EXCEL_DATE_FORMAT = "DD.MM.YYYY HH:mm";
const EXCEL_INT_FORMAT = "#,##0";
const EXCEL_DECIMAL_FORMAT = "0.0";
const SUMMARY_SHEET_NAME = "Xulosa";
const UTF8_BOM = "﻿";
const CSV_EOL = "\r\n";

/** CSV va Excel matn kataklari uchun bitta ko'rinish. */
function toDisplayText(kind: ReportCellKind, value: ReportCellValue): string {
	if (value === null) {
		return "";
	}

	if (kind === "datetime") {
		return value instanceof Date ? formatDateTime(value) : String(value);
	}

	if (kind === "phone") {
		return formatUzPhone(String(value));
	}

	return String(value);
}

function escapeCsv(value: string): string {
	if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
		return `"${value.replace(/"/g, '""')}"`;
	}

	return value;
}

function styleHeaderRow(row: ExcelJS.Row): void {
	row.height = 22;
	row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
	row.alignment = { vertical: "middle", horizontal: "left" };
	row.eachCell((cell) => {
		cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
		cell.border = { bottom: { style: "thin", color: { argb: BORDER_COLOR } } };
	});
}

function styleTotalsRow(row: ExcelJS.Row): void {
	row.font = { bold: true };
	row.eachCell((cell) => {
		cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTALS_FILL } };
		cell.border = { top: { style: "medium", color: { argb: HEADER_FILL } } };
	});
}

function writeCell(cell: ExcelJS.Cell, kind: ReportCellKind, value: ReportCellValue): void {
	if (value === null) {
		// Bo'sh katak — hisoblab bo'lmagan ko'rsatkich o'rniga 0 yozilmaydi.
		cell.value = null;

		return;
	}

	if (kind === "datetime") {
		if (value instanceof Date) {
			cell.value = toExcelDate(value);
			cell.numFmt = EXCEL_DATE_FORMAT;
		} else {
			cell.value = String(value);
		}

		return;
	}

	if (kind === "number" || kind === "decimal") {
		cell.value = typeof value === "number" ? value : Number(value);
		cell.numFmt = kind === "decimal" ? EXCEL_DECIMAL_FORMAT : EXCEL_INT_FORMAT;

		return;
	}

	cell.value = toDisplayText(kind, value);
}

function addSummarySheet<TRow>(workbook: ExcelJS.Workbook, doc: ReportDocument<TRow>): void {
	const sheet = workbook.addWorksheet(SUMMARY_SHEET_NAME);
	sheet.columns = [
		{ header: "Ko'rsatkich", key: "label", width: 44 },
		{ header: "Qiymat", key: "value", width: 34 },
	];
	styleHeaderRow(sheet.getRow(1));

	const sections: { title: string; items: ReportKeyValue[] }[] = [
		{ title: "Hisobot ma'lumotlari", items: doc.meta },
		{ title: "Ko'rsatkichlar", items: doc.summary },
	];

	for (const section of sections) {
		if (section.items.length === 0) {
			continue;
		}

		const titleRow = sheet.addRow({ label: section.title, value: "" });
		titleRow.font = { bold: true, color: { argb: HEADER_FILL } };

		for (const item of section.items) {
			sheet.addRow({ label: item.label, value: item.value || NO_DATA_LABEL });
		}

		sheet.addRow({ label: "", value: "" });
	}
}

/** xlsx: muzlatilgan bo'yalgan sarlavha, ustun kengliklari, JAMI qatori, Xulosa varag'i. */
export async function renderXlsx<TRow>(doc: ReportDocument<TRow>): Promise<ExportFile> {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = "CallCenter Aqlli Shahar";
	workbook.created = new Date();

	const sheet = workbook.addWorksheet(doc.sheetName, {
		views: [{ state: "frozen", ySplit: 1 }],
	});

	sheet.columns = doc.columns.map((column) => ({ header: column.header, width: column.width }));
	styleHeaderRow(sheet.getRow(1));

	for (const row of doc.rows) {
		const excelRow = sheet.addRow([]);

		doc.columns.forEach((column, index) => {
			writeCell(excelRow.getCell(index + 1), column.kind, column.value(row));
		});
	}

	// Filtr faqat ma'lumot qatorlarini qamrab oladi — JAMI qatori tashqarida.
	sheet.autoFilter = {
		from: { row: 1, column: 1 },
		to: { row: 1 + doc.rows.length, column: doc.columns.length },
	};

	// Bo'sh ajratuvchi qator — JAMI ma'lumot qatorlariga qo'shilib ketmasligi uchun.
	sheet.addRow([]);

	const totalsRow = sheet.addRow([]);
	totalsRow.getCell(1).value = doc.totalsLabel;

	doc.totalsRow.forEach((value, index) => {
		if (index === 0 || value === null) {
			return;
		}

		const column = doc.columns[index];

		writeCell(totalsRow.getCell(index + 1), column?.kind ?? "text", value);
	});
	styleTotalsRow(totalsRow);

	addSummarySheet(workbook, doc);

	const buffer = await workbook.xlsx.writeBuffer();

	return {
		fileName: `${doc.fileBaseName}.xlsx`,
		contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		body: buffer,
	};
}

/** csv: sarlavha, qatorlar, JAMI qatori va oxirida "Ko'rsatkich,Qiymat" xulosasi. */
export function renderCsv<TRow>(doc: ReportDocument<TRow>): ExportFile {
	const lines: string[] = [];

	lines.push(doc.columns.map((column) => escapeCsv(column.header)).join(","));

	for (const row of doc.rows) {
		lines.push(
			doc.columns
				.map((column) => escapeCsv(toDisplayText(column.kind, column.value(row))))
				.join(",")
		);
	}

	lines.push("");
	lines.push(
		doc.columns
			.map((column, index) => {
				if (index === 0) {
					return escapeCsv(doc.totalsLabel);
				}

				return escapeCsv(toDisplayText(column.kind, doc.totalsRow[index] ?? null));
			})
			.join(",")
	);

	lines.push("");
	lines.push(`${escapeCsv("Ko'rsatkich")},${escapeCsv("Qiymat")}`);

	for (const item of [...doc.meta, ...doc.summary]) {
		lines.push(`${escapeCsv(item.label)},${escapeCsv(item.value || NO_DATA_LABEL)}`);
	}

	return {
		fileName: `${doc.fileBaseName}.csv`,
		contentType: "text/csv; charset=utf-8",
		body: `${UTF8_BOM}${lines.join(CSV_EOL)}${CSV_EOL}`,
	};
}

/** Brauzer yuklab olishi uchun to'g'ri Content-Type va Content-Disposition. */
export function toFileResponse(file: ExportFile): Response {
	const encodedName = encodeURIComponent(file.fileName);

	return new Response(file.body, {
		status: 200,
		headers: {
			"Content-Type": file.contentType,
			"Content-Disposition": `attachment; filename="${file.fileName}"; filename*=UTF-8''${encodedName}`,
			"Cache-Control": "no-store",
		},
	});
}
