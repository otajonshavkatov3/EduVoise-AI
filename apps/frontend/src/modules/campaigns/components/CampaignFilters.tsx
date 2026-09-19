import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Card, Input, Select } from "antd";
import { useDebouncedCallback } from "@/shared/hooks/useDebouncedCallback";
import type { CampaignKind, CampaignStatus } from "../types";
import { CAMPAIGN_KIND_LABELS, CAMPAIGN_STATUS_LABELS, optionsFrom } from "../utils/labels";

interface Props {
	status: CampaignStatus | undefined;
	kind: CampaignKind | undefined;
	q: string | undefined;
	onChange: (patch: { status?: CampaignStatus; kind?: CampaignKind; q?: string }) => void;
	onRefresh: () => void;
	isFetching: boolean;
}

const STATUS_OPTIONS = optionsFrom(CAMPAIGN_STATUS_LABELS);
const KIND_OPTIONS = optionsFrom(CAMPAIGN_KIND_LABELS);

export function CampaignFilters({ status, kind, q, onChange, onRefresh, isFetching }: Props) {
	// Har harf uchun so'rov yubormaslik uchun — jadval ochilishida sakrab turadi.
	const handleSearch = useDebouncedCallback((value: string) => onChange({ q: value }));

	return (
		<Card className="mb-6 rounded-2xl border-none shadow-sm">
			<div className="flex flex-wrap items-center gap-3">
				<Input
					allowClear
					prefix={<SearchOutlined className="text-slate-400" />}
					placeholder="Nom yoki maqsad bo'yicha izlash"
					defaultValue={q}
					onChange={(event) => handleSearch(event.target.value)}
					className="h-11 w-full rounded-xl md:w-80"
				/>
				<Select<CampaignStatus>
					allowClear
					placeholder="Holat"
					value={status}
					options={STATUS_OPTIONS}
					onChange={(value) => onChange({ status: value })}
					className="h-11 w-full md:w-44"
				/>
				<Select<CampaignKind>
					allowClear
					placeholder="Turi"
					value={kind}
					options={KIND_OPTIONS}
					onChange={(value) => onChange({ kind: value })}
					className="h-11 w-full md:w-44"
				/>
				<Button
					icon={<ReloadOutlined />}
					loading={isFetching}
					onClick={onRefresh}
					className="h-11 rounded-xl font-bold"
				>
					Yangilash
				</Button>
			</div>
		</Card>
	);
}
