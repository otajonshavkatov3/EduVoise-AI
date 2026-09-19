import { DollarOutlined, LockOutlined } from "@ant-design/icons";
import { Card, Typography } from "antd";
import type { ReactNode } from "react";
import { SessionCostCard } from "@/modules/ai-assistant/components/SessionCostCard";
import type { CallFullCost } from "../../types/callFull";

const { Text } = Typography;

interface Props {
	cost: CallFullCost | null;
	/** false — bu rol xarajatni ko'rmaydi (/ai-costs bilan bir xil qoida). */
	costVisible: boolean;
	/** Narxlanadigan narsa bormi — bo'sh holat matnini shu aniqlaydi. */
	hasAiWork: boolean;
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<div className="flex items-center gap-2 py-3">
					<DollarOutlined className="text-blue-600" />
					<span className="font-black text-slate-900">{title}</span>
				</div>
			}
		>
			{children}
		</Card>
	);
}

/**
 * Bu qo'ng'iroqning AI xarajati.
 *
 * Uchta holat ataylab ajratilgan: ruxsat yo'q, narxlanadigan ish yo'q va
 * haqiqiy raqam. Ikkinchisini nollar bilan ko'rsatish "qo'ng'iroq tekin
 * tushdi" degan noto'g'ri xabar berardi.
 *
 * Raqamni AI sessiyasi sahifasidagi kartaning o'zi chizadi — ikkala sahifa bir
 * xil hisobdan (`buildSessionCostView`) oziqlanadi va bir-biriga zid son
 * ko'rsata olmaydi.
 */
export function CallCostCard({ cost, costVisible, hasAiWork }: Props) {
	if (!costVisible) {
		return (
			<Shell title="Qo'ng'iroq narxi">
				<div className="flex items-start gap-3 rounded-xl bg-slate-50 px-4 py-4">
					<LockOutlined className="mt-0.5 text-slate-400" />
					<div>
						<Text className="block text-sm font-bold text-slate-600">Ruxsat yo'q</Text>
						<Text className="mt-1 block text-[11px] font-medium text-slate-400">
							Xarajat raqamlarini faqat supervisor va administrator ko'radi. Token sarfi quyida, AI
							sessiyasi kartasida ochiq turadi.
						</Text>
					</div>
				</div>
			</Shell>
		);
	}

	if (!cost) {
		return (
			<Shell title="Qo'ng'iroq narxi">
				<Text className="block text-sm font-bold text-slate-600">Narxlanadigan sarf yo'q</Text>
				<Text className="mt-1 block text-[11px] font-medium text-slate-400">
					{hasAiWork
						? "Sarf qayd etilmagan — narx hisoblab bo'lmaydi."
						: "Bu qo'ng'iroqda AI sessiyasi ham, tahlil ham bo'lmagan, shuning uchun hisoblanadigan xarajat yo'q."}
				</Text>
			</Shell>
		);
	}

	return <SessionCostCard cost={cost} />;
}
