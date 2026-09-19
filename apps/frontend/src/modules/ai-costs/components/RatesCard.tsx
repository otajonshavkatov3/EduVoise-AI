import { EditOutlined } from "@ant-design/icons";
import { Button, Card, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import type { ObservedModel, RateItem } from "../types";
import { providerLabel } from "../utils/format";

interface Props {
	items: RateItem[];
	observedModels: ObservedModel[];
	isLoading: boolean;
}

const columns: ColumnsType<RateItem> = [
	{
		title: "Narx qatori",
		dataIndex: "label",
		key: "label",
		render: (label: string) => <span className="text-xs font-bold text-slate-700">{label}</span>,
	},
	{
		title: "Qiymat",
		key: "value",
		width: 160,
		align: "right",
		render: (_, row) => (
			<span className="text-xs font-bold tabular-nums text-slate-900">
				{row.key === "pricing.usdToUzs"
					? row.value === 0
						? "kiritilmagan"
						: `${new Intl.NumberFormat("uz-UZ").format(row.value)} so'm`
					: `$${row.value}`}
			</span>
		),
	},
	{
		title: "Holati",
		key: "isDefault",
		width: 150,
		render: (_, row) =>
			row.isDefault ? (
				<Tag color="orange" className="rounded-md font-bold">
					Tasdiqlanmagan (standart)
				</Tag>
			) : (
				<Tag color="green" className="rounded-md font-bold">
					Tasdiqlangan
				</Tag>
			),
	},
];

/**
 * The rate table the money above was computed from, plus which models those
 * rates were actually applied to.
 *
 * Rates are keyed by provider, not by provider+model, so "which model does this
 * price apply to" can only be answered by the data: `observedModels` is the set
 * of models that really ran. If a model changed and the price moved with it,
 * this is where that becomes visible.
 */
export function RatesCard({ items, observedModels, isLoading }: Props) {
	return (
		<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
			<div className="flex flex-wrap items-start justify-between gap-4 px-6 pb-2 pt-5">
				<div>
					<h3 className="text-lg font-extrabold tracking-tight text-slate-900">Amaldagi narxlar</h3>
					<p className="text-xs font-medium text-slate-500">
						1 mln token uchun AQSh dollarida. Narx o'zgartirilsa butun tarix darhol qayta
						hisoblanadi — saqlangan narx yo'q.
					</p>
					{observedModels.length > 0 && (
						<p className="mt-2 text-[11px] font-medium text-slate-400">
							Tanlangan oraliqda uchragan modellar:{" "}
							{observedModels
								.map((item) => `${providerLabel(item.provider)} — ${item.model ?? "yozilmagan"}`)
								.join(" · ")}
						</p>
					)}
				</div>
				<Link to="/settings">
					<Button icon={<EditOutlined />} className="h-11 rounded-xl font-bold">
						Narxlarni tahrirlash
					</Button>
				</Link>
			</div>
			<Table<RateItem>
				columns={columns}
				dataSource={items}
				loading={isLoading}
				rowKey="key"
				size="small"
				pagination={false}
			/>
		</Card>
	);
}
