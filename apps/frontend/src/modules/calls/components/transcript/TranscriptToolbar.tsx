import {
	DownloadOutlined,
	PlusOutlined,
	SearchOutlined,
	SortAscendingOutlined,
	SortDescendingOutlined,
} from "@ant-design/icons";
import { Button, Card, Input, Segmented, Select, Space, Switch, Tooltip, Typography } from "antd";
import type {
	TranscriptExportFormat,
	TranscriptFilters,
	TranscriptRole,
} from "../../types/transcript";

const { Text } = Typography;

interface Props {
	filters: TranscriptFilters;
	onFiltersChange: (filters: Partial<TranscriptFilters>) => void;
	canEdit: boolean;
	isExporting: boolean;
	onExport: (format: TranscriptExportFormat) => void;
	onAppend: () => void;
}

const ROLE_OPTIONS: { value: TranscriptRole; label: string }[] = [
	{ value: "caller", label: "Mijoz" },
	{ value: "agent", label: "Operator / AI" },
	{ value: "system", label: "Tizim" },
];

export function TranscriptToolbar({
	filters,
	onFiltersChange,
	canEdit,
	isExporting,
	onExport,
	onAppend,
}: Props) {
	const isDescending = filters.order === "desc";

	return (
		<Card className="mb-6 overflow-hidden rounded-2xl border-none bg-white/60 shadow-sm backdrop-blur-md">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<Space wrap size="middle" className="flex-1">
					<Input
						allowClear
						placeholder="Transkript ichidan qidirish..."
						prefix={<SearchOutlined className="text-slate-400" />}
						value={filters.search}
						onChange={(event) =>
							onFiltersChange({ search: event.target.value || undefined, page: 1 })
						}
						className="h-12 w-[260px] rounded-xl border-slate-200 bg-slate-50"
					/>

					<Select<TranscriptRole>
						allowClear
						placeholder="Kim gapirdi"
						options={ROLE_OPTIONS}
						value={filters.role}
						onChange={(value) => onFiltersChange({ role: value, page: 1 })}
						className="custom-select w-[180px]"
					/>

					<Segmented
						size="large"
						value={isDescending ? "desc" : "asc"}
						onChange={(value) => onFiltersChange({ order: value as "asc" | "desc", page: 1 })}
						options={[
							{ value: "asc", icon: <SortAscendingOutlined />, label: "Boshidan" },
							{ value: "desc", icon: <SortDescendingOutlined />, label: "Oxiridan" },
						]}
					/>

					<Space size="small">
						<Switch
							size="small"
							checked={filters.includeInterim === "true"}
							onChange={(checked) =>
								onFiltersChange({ includeInterim: checked ? "true" : "false", page: 1 })
							}
						/>
						<Text className="text-[11px] font-bold text-slate-500">Yakunlanmagan qatorlar</Text>
					</Space>
				</Space>

				<Space size="small">
					{canEdit && (
						<Tooltip title="Qo'lda qator qo'shish">
							<Button
								icon={<PlusOutlined />}
								onClick={onAppend}
								className="h-12 rounded-xl font-bold"
							>
								Qator
							</Button>
						</Tooltip>
					)}
					<Button
						icon={<DownloadOutlined />}
						loading={isExporting}
						onClick={() => onExport("txt")}
						className="h-12 rounded-xl font-bold"
					>
						TXT
					</Button>
					<Button
						icon={<DownloadOutlined />}
						loading={isExporting}
						onClick={() => onExport("csv")}
						className="h-12 rounded-xl font-bold"
					>
						CSV
					</Button>
				</Space>
			</div>
		</Card>
	);
}
