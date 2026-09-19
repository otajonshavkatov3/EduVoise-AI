import { CheckCircleOutlined, CloseOutlined, SwapOutlined } from "@ant-design/icons";
import { Alert, Button } from "antd";

interface ConsultingAlertProps {
	consultingWith: string | null;
	isTransferring: boolean;
	onCancel: () => void;
	onComplete: () => void;
}

export function ConsultingAlert({
	consultingWith,
	isTransferring,
	onCancel,
	onComplete,
}: ConsultingAlertProps) {
	return (
		<div className="mb-4 mt-2">
			<Alert
				type="info"
				className="rounded-2xl border-blue-100 bg-blue-50"
				icon={<SwapOutlined className="text-blue-500" />}
				showIcon
				message={
					<div>
						<div className="font-bold text-slate-800 text-sm">
							{consultingWith} bilan bog'lanmoqda
						</div>
						<div className="text-[10px] text-slate-500 font-medium mt-0.5">
							Asosiy qo'ng'iroq kutish rejimida. Operator tayyor bo'lgach «Uzatishni yakunlash»
							tugmasini bosing.
						</div>
					</div>
				}
			/>
			<div className="grid grid-cols-2 gap-3 mt-4">
				<Button
					danger
					onClick={onCancel}
					icon={<CloseOutlined />}
					className="h-12 rounded-2xl font-bold border-red-100 bg-red-50 text-red-500 hover:bg-red-100! hover:border-red-200!"
				>
					Bekor qilish
				</Button>
				<Button
					type="primary"
					loading={isTransferring}
					onClick={onComplete}
					icon={<CheckCircleOutlined />}
					className="h-12 rounded-2xl font-black bg-emerald-500 hover:bg-emerald-600! border-none shadow-lg shadow-emerald-500/20"
				>
					Uzatishni yakunlash
				</Button>
			</div>
		</div>
	);
}
