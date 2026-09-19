import { ApiOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { Alert } from "antd";
import type { DialingReadiness } from "../types";

interface Props {
	dialing: DialingReadiness;
	/** Kompakt ko'rinish — ro'yxat va modal ichida. */
	compact?: boolean;
}

/**
 * The single most important honest statement on these screens.
 *
 * `SIP_TRUNK_HOST` is empty in this deployment, so Asterisk was started without a
 * PSTN trunk and the platform can reach internal PJSIP endpoints (101-104 desk,
 * 201-204 browser) and nothing else. A campaign of mobile numbers would fail on
 * every row. The feature is NOT disabled for it - internal extensions are how it
 * is tested today - but nobody gets to press "start" without being told, and the
 * text says what it takes to fix rather than just that something is wrong.
 *
 * The judgement is the server's (`describeReadiness`), including the sentence:
 * duplicating it here would let the page and the API disagree about whether a
 * campaign can dial.
 */
export function TrunkNotice({ dialing, compact = false }: Props) {
	if (dialing.warning.length === 0) {
		if (compact) {
			return null;
		}

		return (
			<Alert
				type="success"
				showIcon
				icon={<CheckCircleOutlined />}
				className="mb-4 rounded-2xl"
				message="Tashqi liniya sozlangan — ro'yxatdagi raqamlarga qo'ng'iroq qilinadi"
			/>
		);
	}

	return (
		<Alert
			type={dialing.canDial ? "warning" : "error"}
			showIcon
			icon={<ApiOutlined />}
			className={compact ? "rounded-2xl" : "mb-4 rounded-2xl"}
			message={
				dialing.canDial
					? "Tashqi liniya (SIP trunk) sozlanmagan — faqat ichki raqamlar teriladi"
					: "Bu kampaniya birorta raqamga qo'ng'iroq qila olmaydi"
			}
			description={<span className="text-sm leading-relaxed">{dialing.warning}</span>}
		/>
	);
}
