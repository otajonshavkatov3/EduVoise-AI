import { LockOutlined } from "@ant-design/icons";
import { Card } from "antd";

/** Manager roli uchun: backend ham 403 qaytaradi, shuning uchun bo'sh jadval ko'rsatilmaydi. */
export function ReportsAccessDenied() {
	return (
		<div className="animate-fadeIn">
			<Card className="rounded-2xl border-none shadow-sm">
				<div className="flex flex-col items-center gap-3 py-10 text-center">
					<LockOutlined className="text-3xl text-slate-300" />
					<h1 className="text-xl font-black text-slate-900">Hisobotlar yopiq</h1>
					<p className="max-w-md font-medium text-slate-500">
						Hisobotlarni ko'rish va eksport qilish faqat administrator va nazoratchi rollariga
						ruxsat etilgan.
					</p>
				</div>
			</Card>
		</div>
	);
}
