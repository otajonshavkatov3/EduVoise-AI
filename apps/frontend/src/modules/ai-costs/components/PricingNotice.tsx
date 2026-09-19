import { InfoCircleOutlined } from "@ant-design/icons";
import { Alert } from "antd";
import { Link } from "react-router-dom";
import type { PricingStatus } from "../types";
import { formatDateTime } from "../utils/format";

/**
 * The honesty banner.
 *
 * The rates ship with the vendors' published list prices so the page produces a
 * real number on day one - but nothing here can check a price list, so until the
 * owner has confirmed them against an actual invoice every figure below is an
 * estimate built on someone else's numbers. This says so, at the top.
 *
 * Unreviewed rates and zeroed rates are independent faults, so the two warnings
 * stack instead of replacing each other. Zeroing one line while seventeen others
 * are still defaults is the normal way to reach that state, and a zeroed line is
 * the more serious of the two because it silently understates the total - it can
 * never wait for every other rate to be confirmed first.
 */
export function PricingNotice({ pricing }: { pricing: PricingStatus }) {
	// Every rate is zero here, so the zero-rate warning below would only restate
	// this banner.
	if (!pricing.configured) {
		return (
			<Alert
				type="warning"
				showIcon
				className="mb-6 rounded-2xl"
				message="Narxlar kiritilmagan"
				description={
					<span>
						Barcha narxlar nolga teng, shuning uchun faqat token sarfi ko'rsatilmoqda.{" "}
						<Link to="/settings" className="font-bold">
							Sozlamalar → Narxlar
						</Link>{" "}
						bo'limida 1 mln token narxini kiriting.
					</span>
				}
			/>
		);
	}

	const zeroAlert =
		pricing.zeroKeys.length > 0 ? (
			<Alert
				type="warning"
				showIcon
				className="mb-6 rounded-2xl"
				message={`${pricing.zeroKeys.length} ta narx nolga teng`}
				description="Nolga teng qatorlar hisob-kitobga kirmaydi, ya'ni umumiy xarajat aslidan kam ko'rsatilishi mumkin."
			/>
		) : null;

	const unreviewedAlert =
		pricing.unreviewedCount > 0 ? (
			<Alert
				type="info"
				showIcon
				icon={<InfoCircleOutlined />}
				className="mb-6 rounded-2xl"
				message={`${pricing.unreviewedCount} ta narx hali tasdiqlanmagan`}
				description={
					<span>
						Hisob-kitob oldindan kiritilgan standart narxlar bo'yicha yuritilmoqda — bu e'lon
						qilingan narxnomadan olingan taxmin, sizning hisob-fakturangiz emas.{" "}
						<Link to="/settings" className="font-bold">
							Sozlamalar → Narxlar
						</Link>{" "}
						bo'limida har bir qiymatni tekshirib chiqing.
					</span>
				}
			/>
		) : null;

	if (zeroAlert === null && unreviewedAlert === null) {
		return (
			<Alert
				type="success"
				showIcon
				className="mb-6 rounded-2xl"
				message="Narxlar tasdiqlangan"
				description={`Oxirgi marta ${formatDateTime(pricing.lastReviewedAt)} da yangilangan. Narx o'zgartirilsa butun tarix darhol qayta hisoblanadi.`}
			/>
		);
	}

	// Worst first: the understated total outranks "not confirmed yet".
	return (
		<>
			{zeroAlert}
			{unreviewedAlert}
		</>
	);
}
