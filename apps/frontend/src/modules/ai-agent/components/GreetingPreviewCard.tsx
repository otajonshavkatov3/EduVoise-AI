import { CustomerServiceOutlined, MoonOutlined, SoundOutlined } from "@ant-design/icons";
import { Tag } from "antd";
import { UNKNOWN_POLICY_OPTIONS } from "../utils/labels";
import { buildGreetingPreview, type ProfileFormValues } from "../utils/profileForm";

interface Props {
	values: ProfileFormValues;
}

/**
 * Mijoz go'shakni ko'targanda nima eshitadi.
 *
 * Shakl tepasida turadi va yozilayotgan matnni darhol ko'rsatadi: salomlashish
 * matni telefonda qanday eshitilishini o'qib ko'rmasdan yozish qiyin.
 */
export function GreetingPreviewCard({ values }: Props) {
	const greeting = buildGreetingPreview(values);
	const afterHours = values.afterHoursMessage.trim();
	const policy = UNKNOWN_POLICY_OPTIONS.find((item) => item.value === values.unknownPolicy);

	return (
		<div className="rounded-2xl border border-blue-100 bg-blue-50/60 p-4">
			<div className="mb-3 flex items-center gap-2">
				<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-white">
					<SoundOutlined />
				</div>
				<div>
					<div className="text-sm font-black text-slate-900">Mijoz nima eshitadi</div>
					<div className="text-[9px] font-bold tracking-widest text-slate-400 uppercase">
						Taxminiy matn — model ohangni bir oz o'zgartirishi mumkin
					</div>
				</div>
			</div>

			<div className="rounded-2xl rounded-bl-sm border border-blue-100 bg-white px-4 py-3">
				<div className="mb-1 flex items-center gap-2 text-[10px] font-black tracking-widest text-blue-500 uppercase">
					<CustomerServiceOutlined />
					Ish vaqtida
				</div>
				<p className="m-0 text-sm leading-relaxed font-medium text-slate-800">{greeting}</p>
			</div>

			{values.hoursEnabled && (
				<div className="mt-3 rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-3">
					<div className="mb-1 flex items-center gap-2 text-[10px] font-black tracking-widest text-slate-400 uppercase">
						<MoonOutlined />
						Ish vaqtidan tashqari
					</div>
					<p className="m-0 text-sm leading-relaxed font-medium text-slate-600">
						{afterHours.length > 0
							? afterHours
							: "Matn kiritilmagan — AI umumiy javob beradi va murojaatni yozib oladi."}
					</p>
				</div>
			)}

			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Tag color="geekblue" className="m-0 rounded-lg border-none text-[10px] font-bold">
					Javob topilmasa: {policy?.label ?? "—"}
				</Tag>
				<span className="text-xs font-medium text-slate-500">
					AI faqat bilim bazasidagi ma'lumotni aytadi — narx, manzil va ish vaqtini o'zidan
					to'qimaydi.
				</span>
			</div>
		</div>
	);
}
