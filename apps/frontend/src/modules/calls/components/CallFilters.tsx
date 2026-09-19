import {
	DownloadOutlined,
	FilterOutlined,
	PhoneOutlined,
	ReloadOutlined,
	SlidersOutlined,
} from "@ant-design/icons";
import { Badge, Button, Card, DatePicker, Input, Select, Space, Tooltip } from "antd";
import { useState } from "react";
import { useOperators } from "@/modules/operators/hooks/useOperators";
import type { AIStatus, CallDirection, CallStatus, CallFilters as ICallFilters } from "../types";
import type { Sentiment } from "../types/analysis";
import { SENTIMENT_OPTIONS } from "../utils/analysis";

const { RangePicker } = DatePicker;

interface Props {
	filters: ICallFilters;
	onFiltersChange: (filters: Partial<ICallFilters>) => void;
	onReset: () => void;
	onRefresh: () => void;
	onExport: () => void;
	isExporting: boolean;
	isFetching: boolean;
	/**
	 * Javobsiz qo'ng'iroqlar sahifasida holatni server o'zi belgilaydi, shuning
	 * uchun u yerda tanlov ko'rsatilmaydi — hech narsaga ta'sir qilmasdi.
	 */
	showStatus?: boolean;
}

/** Backend `phoneNumber` ni aniq moslik bilan qidiradi va shu shaklni talab qiladi. */
const FULL_NUMBER = /^\+?[1-9]\d{1,14}$/;

const STATUS_OPTIONS: Array<{ value: CallStatus; label: string }> = [
	{ value: "ringing", label: "Chalinmoqda" },
	{ value: "answered", label: "Javob berilgan" },
	{ value: "missed", label: "O'tkazib yuborilgan" },
	{ value: "abandoned", label: "Tashlab ketilgan" },
	{ value: "completed", label: "Yakunlangan" },
];

const DIRECTION_OPTIONS: Array<{ value: CallDirection; label: string }> = [
	{ value: "inbound", label: "Kiruvchi" },
	{ value: "outbound", label: "Chiquvchi" },
];

const AI_STATUS_OPTIONS: Array<{ value: AIStatus; label: string }> = [
	{ value: "pending", label: "Navbatda" },
	{ value: "processing", label: "Tahlil qilinmoqda" },
	{ value: "completed", label: "Tahlil tayyor" },
	{ value: "failed", label: "Tahlil xatosi" },
];

const RECORDING_OPTIONS: Array<{ value: "true" | "false"; label: string }> = [
	{ value: "true", label: "Yozuv bor" },
	{ value: "false", label: "Yozuv yo'q" },
];

/** Yig'ilgan panel ortida qolgan filtrlar soni — yashiringan filtr ko'rinmay qolmasligi uchun. */
function countAdvanced(filters: ICallFilters): number {
	return [filters.operatorId, filters.aiStatus, filters.sentiment, filters.hasRecording].filter(
		(value) => value !== undefined
	).length;
}

export function CallFilters({
	filters,
	onFiltersChange,
	onReset,
	onRefresh,
	onExport,
	isExporting,
	isFetching,
	showStatus = true,
}: Props) {
	const [showAdvanced, setShowAdvanced] = useState(false);
	// Operator ro'yxati faqat panel ochilganda kerak.
	const { data: operatorsData, isLoading: isLoadingOperators } = useOperators({ limit: 100 });

	const operatorOptions = (operatorsData?.data.items ?? []).map((operator) => ({
		value: operator.id,
		label: `${operator.extension} — ${operator.user?.phone ?? "Operator"}`,
	}));

	const advancedCount = countAdvanced(filters);

	/**
	 * `GET /calls` da matnli qidiruv yo'q — faqat `phoneNumber` bo'yicha ANIQ
	 * moslik bor. Shuning uchun bu maydon "qidiruv" emas, to'liq raqam filtri
	 * sifatida belgilangan: raqam to'liq bo'lmasa filtr qo'llanmaydi.
	 */
	const handleNumberChange = (value: string) => {
		const trimmed = value.trim();
		if (trimmed === "") {
			onFiltersChange({ phoneNumber: undefined, page: 1 });
			return;
		}
		if (FULL_NUMBER.test(trimmed)) {
			onFiltersChange({ phoneNumber: trimmed, page: 1 });
		}
	};

	return (
		<Card className="mb-6 overflow-hidden rounded-2xl border-none bg-white/60 shadow-sm backdrop-blur-md">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<Space wrap size="middle" className="flex-1">
					<Tooltip title="Server faqat to'liq raqam bo'yicha aniq moslikni qo'llaydi, masalan +998901234567">
						<Input
							placeholder="To'liq raqam: +998901234567"
							prefix={<PhoneOutlined className="text-slate-400" />}
							allowClear
							className="h-11 w-[260px] rounded-xl border-slate-200 bg-slate-50"
							onChange={(e) => handleNumberChange(e.target.value)}
						/>
					</Tooltip>

					{showStatus && (
						<Select<CallStatus>
							placeholder="Holati"
							className="custom-select h-11 w-[170px]"
							allowClear
							value={filters.status}
							options={STATUS_OPTIONS}
							onChange={(status) => onFiltersChange({ status, page: 1 })}
							suffixIcon={<FilterOutlined className="text-slate-400" />}
						/>
					)}

					<Select<CallDirection>
						placeholder="Yo'nalishi"
						className="custom-select h-11 w-[150px]"
						allowClear
						value={filters.direction}
						options={DIRECTION_OPTIONS}
						onChange={(direction) => onFiltersChange({ direction, page: 1 })}
					/>

					<RangePicker
						showTime
						className="h-11 rounded-xl border-slate-200"
						placeholder={["Boshlanish", "Tugash"]}
						onChange={(dates) => {
							onFiltersChange({
								from: dates?.[0]?.toISOString(),
								to: dates?.[1]?.toISOString(),
								page: 1,
							});
						}}
					/>

					<Badge count={advancedCount} size="small" offset={[-6, 4]}>
						<Button
							icon={<SlidersOutlined />}
							onClick={() => setShowAdvanced((open) => !open)}
							className={`h-11 rounded-xl font-bold ${showAdvanced ? "border-blue-200 text-blue-600" : ""}`}
						>
							Qo'shimcha filtrlar
						</Button>
					</Badge>
				</Space>

				<Space size="small">
					<Button onClick={onReset} className="h-11 rounded-xl font-bold">
						Tozalash
					</Button>
					<Tooltip title="Yangilash">
						<Button
							icon={<ReloadOutlined />}
							loading={isFetching}
							onClick={onRefresh}
							className="h-11 w-11 rounded-xl"
						/>
					</Tooltip>
					<Button
						icon={<DownloadOutlined />}
						onClick={onExport}
						loading={isExporting}
						className="flex h-11 items-center gap-2 rounded-xl border-blue-100 px-6 font-bold text-blue-600 transition-all hover:bg-blue-50"
					>
						CSV yuklab olish
					</Button>
				</Space>
			</div>

			{showAdvanced && (
				<div className="mt-4 border-t border-slate-100 pt-4">
					<Space wrap size="middle">
						<Select<string>
							allowClear
							showSearch
							optionFilterProp="label"
							placeholder="Operator"
							loading={isLoadingOperators}
							options={operatorOptions}
							value={filters.operatorId}
							onChange={(operatorId) => onFiltersChange({ operatorId, page: 1 })}
							className="custom-select h-11 w-[240px]"
						/>

						<Select<AIStatus>
							allowClear
							placeholder="AI tahlili"
							options={AI_STATUS_OPTIONS}
							value={filters.aiStatus}
							onChange={(aiStatus) => onFiltersChange({ aiStatus, page: 1 })}
							className="custom-select h-11 w-[190px]"
						/>

						<Select<Sentiment>
							allowClear
							placeholder="Kayfiyat"
							options={SENTIMENT_OPTIONS}
							value={filters.sentiment}
							onChange={(sentiment) => onFiltersChange({ sentiment, page: 1 })}
							className="custom-select h-11 w-[160px]"
						/>

						<Select<"true" | "false">
							allowClear
							placeholder="Ovoz yozuvi"
							options={RECORDING_OPTIONS}
							value={filters.hasRecording}
							onChange={(hasRecording) => onFiltersChange({ hasRecording, page: 1 })}
							className="custom-select h-11 w-[170px]"
						/>
					</Space>
				</div>
			)}
		</Card>
	);
}
