import { CheckCircleOutlined, CloseCircleOutlined, ImportOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Input, Table, Tag } from "antd";
import { useMemo, useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useBulkImportKnowledge } from "../hooks/useKnowledgeBase";
import type { BulkImportResult } from "../types";
import { type ParsedBulkRow, parseBulkInput, toBulkPayload } from "../utils/bulkParse";

const PLACEHOLDER = [
	"ish vaqtingiz qanday? | Har kuni 09:00-18:00, yakshanba dam olish kuni.",
	"manzilingiz qayerda? | Toshkent, Chilonzor 12-kvartal, 5-uy. | manzil, yo'l",
	"tish davolash qancha turadi? | Ko'rikdan keyin aytiladi, ko'rik bepul.",
].join("\n");

interface Props {
	/** Berilmasa aktiv profilga import qilinadi. */
	profileId?: string;
}

/** Natija yuborilgan qatorlar bilan birga saqlanadi — sabablarni bog'lash uchun. */
interface ImportOutcome {
	result: BulkImportResult;
	submitted: ParsedBulkRow[];
}

/** «O'tkazib yuborilgan» va «xato» — boshqa-boshqa holatlar, alohida ko'rsatiladi. */
function summarizeImport(result: BulkImportResult): string {
	const parts = [`${result.created} ta yozuv qo'shildi`];

	if (result.skipped > 0) {
		parts.push(`${result.skipped} ta o'tkazib yuborildi`);
	}
	if (result.failed > 0) {
		parts.push(`${result.failed} ta xato`);
	}

	return parts.join(", ");
}

/**
 * Ommaviy import.
 *
 * Bitta-bitta qo'shish o'nlab savol uchun juda sekin, lekin ko'r-ko'rona import
 * ham xavfli: shuning uchun har bir qator import qilinishidan oldin ko'rinadi va
 * xatosi bo'lgan qator o'tkazib yuboriladi.
 */
export function KnowledgeBulkImport({ profileId }: Props) {
	const [text, setText] = useState("");
	const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
	const [error, setError] = useState<string | null>(null);

	const bulkImport = useBulkImportKnowledge();

	const parsed = useMemo(() => parseBulkInput(text), [text]);

	const handleImport = async () => {
		if (parsed.validRows.length === 0) {
			return;
		}

		setError(null);
		setOutcome(null);

		try {
			const submitted = parsed.validRows;
			const response = await bulkImport.mutateAsync({
				entries: toBulkPayload(submitted),
				profileId,
			});

			// Yuborilgan qatorlar natija bilan birga saqlanadi: server javobidagi
			// `index` shu massivga tegishli, matn esa quyida tozalanib ketishi mumkin.
			setOutcome({ result: response, submitted });

			// Muvaffaqiyatli import qilingan qatorlarni maydonda qoldirish chalkash:
			// import takrorlanib ketishi mumkin.
			if (response.created > 0) {
				setText("");
			}
		} catch (caught) {
			setError(getApiErrorMessage(caught, "Import qilib bo'lmadi"));
		}
	};

	const columns = [
		{
			title: "#",
			key: "line",
			width: 56,
			render: (_: unknown, row: ParsedBulkRow) => (
				<span className="font-mono text-[11px] text-slate-400">{row.line}</span>
			),
		},
		{
			title: "Savol",
			key: "question",
			render: (_: unknown, row: ParsedBulkRow) => (
				<span className="text-xs font-bold text-slate-800">{row.question || "—"}</span>
			),
		},
		{
			title: "Javob",
			key: "answer",
			render: (_: unknown, row: ParsedBulkRow) => (
				<span className="text-xs text-slate-600">
					{row.answer.length > 80 ? `${row.answer.slice(0, 80)}...` : row.answer || "—"}
				</span>
			),
		},
		{
			title: "Teglar",
			key: "tags",
			render: (_: unknown, row: ParsedBulkRow) =>
				row.tags.length === 0 ? (
					<span className="text-xs text-slate-300">—</span>
				) : (
					<div className="flex flex-wrap gap-1">
						{row.tags.map((tag) => (
							<Tag key={tag} className="m-0 rounded-lg border-none text-[10px] font-bold">
								{tag}
							</Tag>
						))}
					</div>
				),
		},
		{
			title: "Holat",
			key: "status",
			render: (_: unknown, row: ParsedBulkRow) =>
				row.error === null ? (
					<Tag
						color="green"
						icon={<CheckCircleOutlined />}
						className="m-0 rounded-lg border-none text-[10px] font-bold"
					>
						Tayyor
					</Tag>
				) : (
					<div className="flex items-center gap-1">
						<CloseCircleOutlined className="text-rose-500" />
						<span className="text-[11px] font-bold text-rose-500">{row.error}</span>
					</div>
				),
		},
	];

	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<div className="flex items-center gap-3">
					<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
						<ImportOutlined />
					</div>
					<div>
						<div className="mb-1 text-sm leading-none font-black text-slate-900">
							Ommaviy import
						</div>
						<div className="text-[9px] leading-none font-bold tracking-widest text-slate-400 uppercase">
							Har qatorga bitta yozuv: savol | javob | teglar (ixtiyoriy)
						</div>
					</div>
				</div>
			}
		>
			<Input.TextArea
				value={text}
				onChange={(event) => setText(event.target.value)}
				rows={6}
				placeholder={PLACEHOLDER}
				className="rounded-2xl border-slate-200 bg-slate-50 font-mono text-xs"
			/>

			{parsed.rows.length > 0 && (
				<div className="mt-4">
					<div className="mb-2 flex flex-wrap items-center gap-2">
						<Tag color="blue" className="m-0 rounded-lg border-none text-[11px] font-bold">
							{parsed.validRows.length} ta tayyor
						</Tag>
						{parsed.invalidCount > 0 && (
							<Tag color="red" className="m-0 rounded-lg border-none text-[11px] font-bold">
								{parsed.invalidCount} ta xato
							</Tag>
						)}
						<span className="text-xs font-medium text-slate-500">
							Xato qatorlar import qilinmaydi — ularni tuzatib qayta urinishingiz mumkin.
						</span>
					</div>

					<Table
						columns={columns}
						dataSource={parsed.rows}
						rowKey="line"
						size="small"
						pagination={false}
						scroll={{ x: 720, y: 260 }}
						rowClassName={(row) => (row.error === null ? "" : "bg-rose-50/60")}
					/>
				</div>
			)}

			{error && (
				<Alert
					type="error"
					showIcon
					className="mt-4 rounded-xl border-rose-200 bg-rose-50"
					title={<span className="font-bold text-rose-600">{error}</span>}
				/>
			)}

			{outcome && (
				<Alert
					type={outcome.result.created > 0 ? "success" : "warning"}
					showIcon
					className={`mt-4 rounded-xl ${
						outcome.result.created > 0
							? "border-emerald-200 bg-emerald-50"
							: "border-amber-200 bg-amber-50"
					}`}
					title={
						<span
							className={`font-bold ${
								outcome.result.created > 0 ? "text-emerald-600" : "text-amber-600"
							}`}
						>
							{summarizeImport(outcome.result)}
						</span>
					}
					description={
						outcome.result.problems.length > 0 ? (
							<ul className="m-0 list-disc space-y-1 pl-4 text-slate-600">
								{outcome.result.problems.map((problem) => (
									<li key={`${problem.index}-${problem.status}`}>
										<span className="font-mono text-[11px] text-slate-400">
											{outcome.submitted[problem.index]?.line ?? problem.index + 1}-qator:{" "}
										</span>
										<span className="font-bold">{problem.question}</span>
										{" — "}
										{problem.reason ??
											(problem.status === "skipped" ? "o'tkazib yuborildi" : "xato")}
									</li>
								))}
							</ul>
						) : null
					}
				/>
			)}

			<div className="mt-4">
				<Button
					type="primary"
					icon={<ImportOutlined />}
					loading={bulkImport.isPending}
					disabled={parsed.validRows.length === 0}
					onClick={handleImport}
					className="h-11 rounded-xl px-6 font-bold shadow-lg shadow-blue-500/20"
				>
					{parsed.validRows.length > 0
						? `Import qilish (${parsed.validRows.length} ta)`
						: "Import qilish"}
				</Button>
			</div>
		</Card>
	);
}
