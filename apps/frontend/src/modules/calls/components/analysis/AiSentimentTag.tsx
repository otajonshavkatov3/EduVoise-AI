import { MinusCircleOutlined } from "@ant-design/icons";
import { Tag } from "antd";
import type { Sentiment } from "../../types/analysis";
import { sentimentConfig } from "../../utils/analysis";

interface Props {
	sentiment: Sentiment | null;
}

/**
 * Kayfiyat tegi. Aniqlanmagan bo'lsa "Aniqlanmagan" ko'rinadi — neytral deb
 * ko'rsatilmaydi, chunki bu ikki xil holat.
 */
export function AiSentimentTag({ sentiment }: Props) {
	if (!sentiment) {
		return (
			<Tag
				icon={<MinusCircleOutlined />}
				className="rounded-lg border-none bg-slate-100 text-[10px] font-bold uppercase text-slate-500"
			>
				Aniqlanmagan
			</Tag>
		);
	}

	const config = sentimentConfig[sentiment];

	return (
		<Tag color={config.color} className="rounded-lg border-none text-[10px] font-bold uppercase">
			{config.label}
		</Tag>
	);
}
