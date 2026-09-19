import {
	CheckCircleOutlined,
	CloseCircleOutlined,
	ImportOutlined,
	PaperClipOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Input, Segmented, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useRef, useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useImportLeads } from "../hooks/useCampaigns";
import type { ImportResult, ImportRowResult } from "../types";
import { IMPORT_REASON_LABELS, IMPORT_REASON_ORDER } from "../utils/labels";

interface Props {
	campaignId: string;
	/** Tugagan yoki bekor qilingan kampaniyaga raqam qo'shilmaydi. */
	disabledReason: string | null;
}

const PLACEHOLDER = [
	"telefon;ism;qarz;sana",
	"998901234567;Alisher;450000;15-avgust",
	"998901234568;Nodira;120000;18-avgust",
	"201;Ichki raqam (sinov uchun)",
].join("\n");

/** Faqat matn fayllari — .xlsx ikkilik format, uni brauzerda ocholmaymiz. */
const ACCEPTED_FILES = ".csv,.txt,.tsv,text/csv,text/plain";
const MAX_FILE_BYTES = 500_000;

/** "14 tasi faylning o'zida takrorlangan, 2 tasi «qo'ng'iroq qilinmasin» ro'yxatida" */
function reasonSummary(result: ImportResult): string | null {
	const parts = IMPORT_REASON_ORDER.filter(
		(reason) => (result.skippedByReason[reason] ?? 0) > 0
	).map((reason) => `${result.skippedByReason[reason]} tasi ${IMPORT_REASON_LABELS[reason]}`);

	return parts.length === 0 ? null : parts.join(", ");
}

function StatusTag({ row }: { row: ImportRowResult }) {
	if (row.status === "created") {
		return (
			<Tag
				color="green"
				icon={<CheckCircleOutlined />}
				className="m-0 rounded-lg border-none text-[10px] font-bold"
			>
				Qo'shildi
			</Tag>
		);
	}

	return (
		<Tag
			color={row.status === "failed" ? "red" : "orange"}
			icon={<CloseCircleOutlined />}
			className="m-0 rounded-lg border-none text-[10px] font-bold"
		>
			{row.status === "failed" ? "Xato" : "O'tkazildi"}
		</Tag>
	);
}

const RESULT_COLUMNS: ColumnsType<ImportRowResult> = [
	{
		title: "Qator",
		key: "line",
		width: 70,
		render: (_, row) => (
			<span className="font-mono text-[11px] text-slate-400">{row.line ?? row.index + 1}</span>
		),
	},
	{
		title: "Kiritilgan",
		key: "input",
		width: 190,
		render: (_, row) => <span className="font-mono text-[11px] text-slate-600">{row.input}</span>,
	},
	{
		title: "Saqlangan raqam",
		key: "phone",
		width: 160,
		render: (_, row) =>
			row.phoneNumber === null ? (
				<span className="text-[11px] text-slate-300">—</span>
			) : (
				<span className="font-mono text-xs font-bold text-slate-900">{row.phoneNumber}</span>
			),
	},
	{
		title: "Ism",
		key: "name",
		width: 140,
		render: (_, row) => <span className="text-xs text-slate-600">{row.fullName ?? "—"}</span>,
	},
	{
		title: "Holat",
		key: "status",
		width: 120,
		render: (_, row) => <StatusTag row={row} />,
	},
	{
		title: "Sabab",
		key: "message",
		render: (_, row) =>
			row.message === null ? (
				<span className="text-[11px] text-slate-300">—</span>
			) : (
				<span className="text-[11px] font-medium text-slate-600">{row.message}</span>
			),
	},
];

/**
 * Paste or file, and then the honest part: every row that did not become a lead
 * comes back with its own reason, on its own line, next to the text it came from.
 *
 * A bare "986 skipped" is unusable - the owner cannot tell a typo from a
 * duplicate from somebody who asked never to be called again, and those three
 * need three different responses. This is the same contract the knowledge-base
 * bulk import already keeps.
 */
export function LeadImportPanel({ campaignId, disabledReason }: Props) {
	const [mode, setMode] = useState<"paste" | "file">("paste");
	const [text, setText] = useState("");
	const [fileName, setFileName] = useState<string | null>(null);
	const [fileError, setFileError] = useState<string | null>(null);
	const [result, setResult] = useState<ImportResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const importLeads = useImportLeads();

	const lineCount = text
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0 && !line.trim().startsWith("#")).length;

	const handleFile = async (file: File | undefined) => {
		if (file === undefined) {
			return;
		}

		setFileError(null);

		if (file.size > MAX_FILE_BYTES) {
			setFileError(
				`Fayl juda katta (${Math.round(file.size / 1024)} KB). Chegara ${MAX_FILE_BYTES / 1000} KB.`
			);
			return;
		}

		// Read in the browser and send the text: the endpoint takes one `text` field,
		// so a file and a paste travel the same path and get the same per-row report.
		const content = await file.text();

		setText(content);
		setFileName(file.name);
	};

	const handleImport = async () => {
		if (text.trim().length === 0) {
			return;
		}

		setError(null);
		setResult(null);

		try {
			const response = await importLeads.mutateAsync({ id: campaignId, text });

			setResult(response);

			// A fully successful import clears the box; a partial one keeps it so the
			// rejected lines can be fixed and sent again.
			if (response.created > 0 && response.skipped === 0 && response.failed === 0) {
				setText("");
				setFileName(null);
			}
		} catch (caught) {
			setError(getApiErrorMessage(caught, "Import qilib bo'lmadi"));
		}
	};

	if (disabledReason !== null) {
		return (
			<Card className="rounded-2xl border-none shadow-sm">
				<Alert type="info" showIcon className="rounded-xl" message={disabledReason} />
			</Card>
		);
	}

	return (
		<Card
			className="rounded-2xl border-none shadow-sm"
			title={
				<div className="flex items-center gap-3">
					<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
						<ImportOutlined />
					</div>
					<div>
						<div className="mb-1 text-sm leading-none font-black text-slate-900">
							Raqamlar ro'yxatini import qilish
						</div>
						<div className="text-[9px] leading-none font-bold tracking-widest text-slate-400 uppercase">
							Birinchi ustun — raqam. Sarlavha qatori bo'lsa avtomatik aniqlanadi
						</div>
					</div>
				</div>
			}
		>
			<Segmented<"paste" | "file">
				value={mode}
				onChange={setMode}
				className="mb-4"
				options={[
					{ value: "paste", label: "Matnni qo'yish" },
					{ value: "file", label: "Fayldan" },
				]}
			/>

			{mode === "file" && (
				<div className="mb-4">
					{/* Hidden native input: the file never leaves the browser as a file - it
					    is read here and sent as text, so there is no upload endpoint and no
					    temporary file on the server. */}
					<input
						ref={fileInputRef}
						type="file"
						accept={ACCEPTED_FILES}
						className="hidden"
						onChange={(event) => handleFile(event.target.files?.[0])}
					/>
					<Button
						icon={<PaperClipOutlined />}
						onClick={() => fileInputRef.current?.click()}
						className="h-11 rounded-xl font-bold"
					>
						{fileName ?? "CSV yoki matn faylini tanlash"}
					</Button>
					<span className="ml-3 text-xs font-medium text-slate-400">
						.csv, .txt, .tsv — Excel'dan «CSV» ko'rinishida saqlang
					</span>
					{fileError !== null && (
						<Alert type="error" showIcon className="mt-3 rounded-xl" message={fileError} />
					)}
				</div>
			)}

			<Input.TextArea
				value={text}
				onChange={(event) => {
					setText(event.target.value);
					setFileName(null);
				}}
				rows={8}
				placeholder={PLACEHOLDER}
				className="rounded-2xl border-slate-200 bg-slate-50 font-mono text-xs"
			/>

			<div className="mt-3 flex flex-wrap items-center gap-3">
				<Button
					type="primary"
					icon={<ImportOutlined />}
					loading={importLeads.isPending}
					disabled={text.trim().length === 0}
					onClick={handleImport}
					className="h-11 rounded-xl px-6 font-bold shadow-lg shadow-blue-500/20"
				>
					{lineCount > 0 ? `Import qilish (${lineCount} ta qator)` : "Import qilish"}
				</Button>
				<span className="text-xs font-medium text-slate-500">
					Ajratgich: tab, nuqtali vergul yoki vergul. Sarlavhadagi ustun nomlari «o'zgaruvchi»
					bo'ladi va har qo'ng'iroq bir xil gapni aytmaydi. Mavjud kontakt topilsa bog'lanadi, yangi
					kontakt yaratilmaydi.
				</span>
			</div>

			{error !== null && (
				<Alert type="error" showIcon className="mt-4 rounded-xl" message={error} />
			)}

			{result !== null && (
				<div className="mt-5">
					<Alert
						type={result.created > 0 ? "success" : "warning"}
						showIcon
						className="rounded-xl"
						message={`${result.submitted} ta qatordan ${result.created} tasi qo'shildi`}
						description={
							<div className="space-y-1 text-slate-600">
								{reasonSummary(result) !== null && <div>{reasonSummary(result)}.</div>}
								{result.parsed !== null && (
									<div className="text-[11px]">
										Aniqlangan sarlavha:{" "}
										{result.parsed.headers === null ? (
											<span className="italic">yo'q — ikkinchi ustun ism deb olindi</span>
										) : (
											<span className="font-bold">{result.parsed.headers.join(", ")}</span>
										)}
										{result.parsed.ignoredLines.length > 0 && (
											<> · e'tiborsiz qatorlar: {result.parsed.ignoredLines.join(", ")}</>
										)}
										{result.parsed.truncated && (
											<span className="font-bold text-amber-600">
												{" "}
												· ro'yxat uzun bo'lgani uchun qisqartirildi
											</span>
										)}
									</div>
								)}
							</div>
						}
					/>

					<Table<ImportRowResult>
						columns={RESULT_COLUMNS}
						dataSource={result.results}
						rowKey={(row) => `${row.index}-${row.input}`}
						size="small"
						className="mt-4"
						scroll={{ x: 860 }}
						pagination={{ pageSize: 10, showSizeChanger: false }}
						rowClassName={(row) => (row.status === "created" ? "" : "bg-amber-50/50")}
					/>
				</div>
			)}
		</Card>
	);
}
