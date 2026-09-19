import { DownloadOutlined, FileExcelOutlined, FileTextOutlined } from "@ant-design/icons";
import { Button, Space, Tooltip } from "antd";
import type { ExportFormat } from "../types";

interface Props {
	/** Yuklanayotgan format (null — hech biri). */
	pendingFormat: ExportFormat | null;
	disabled: boolean;
	onExport: (format: ExportFormat) => void;
	/** Eksportga tushadigan qatorlar soni — tugma yonida ko'rsatiladi. */
	rowCount: number | undefined;
}

export function ExportButtons({ pendingFormat, disabled, onExport, rowCount }: Props) {
	const isBusy = pendingFormat !== null;
	const countLabel = rowCount === undefined ? "" : ` (${rowCount} qator)`;

	return (
		<Space size="small">
			<Tooltip title={`Excel (.xlsx) faylini yuklab olish${countLabel}`}>
				<Button
					type="primary"
					size="large"
					icon={pendingFormat === "xlsx" ? <DownloadOutlined /> : <FileExcelOutlined />}
					loading={pendingFormat === "xlsx"}
					disabled={disabled || (isBusy && pendingFormat !== "xlsx")}
					onClick={() => onExport("xlsx")}
					className="h-12 rounded-xl px-5 font-bold shadow-lg shadow-blue-500/20"
				>
					Excel
				</Button>
			</Tooltip>
			<Tooltip title={`CSV faylini yuklab olish${countLabel}`}>
				<Button
					size="large"
					icon={pendingFormat === "csv" ? <DownloadOutlined /> : <FileTextOutlined />}
					loading={pendingFormat === "csv"}
					disabled={disabled || (isBusy && pendingFormat !== "csv")}
					onClick={() => onExport("csv")}
					className="h-12 rounded-xl px-5 font-bold"
				>
					CSV
				</Button>
			</Tooltip>
		</Space>
	);
}
