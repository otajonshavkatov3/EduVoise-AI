import { Radio } from "antd";
import type { UnknownAnswerPolicy } from "../types";
import { UNKNOWN_POLICY_OPTIONS } from "../utils/labels";

interface Props {
	value: UnknownAnswerPolicy;
	onChange: (next: UnknownAnswerPolicy) => void;
	disabled?: boolean;
}

/**
 * "Javob topilmasa nima qilinadi" tanlovi.
 *
 * Har bir variant yonida sodda tushuntirish turadi, chunki bu sozlama biznes
 * uchun eng qimmatga tushadigan qaror: AI hech qachon narx yoki manzilni
 * o'zidan aytmaydi, shuning uchun javob bo'lmagan holat rostakam yuz beradi.
 */
export function UnknownPolicyPicker({ value, onChange, disabled = false }: Props) {
	return (
		<Radio.Group
			value={value}
			onChange={(event) => onChange(event.target.value as UnknownAnswerPolicy)}
			disabled={disabled}
			className="w-full"
		>
			<div className="flex flex-col gap-3">
				{UNKNOWN_POLICY_OPTIONS.map((option) => {
					const isSelected = option.value === value;

					return (
						<Radio
							key={option.value}
							value={option.value}
							style={{ display: "flex", alignItems: "flex-start", width: "100%", margin: 0 }}
							className={`rounded-2xl border p-4 transition-colors ${
								isSelected ? "border-blue-200 bg-blue-50" : "border-slate-100 bg-slate-50"
							}`}
						>
							<div className="pl-1">
								<div
									className={`text-sm font-black ${isSelected ? "text-blue-700" : "text-slate-900"}`}
								>
									{option.label}
								</div>
								<div className="mt-1 text-xs leading-relaxed font-medium text-slate-600">
									{option.hint}
								</div>
								<div className="mt-2 text-xs italic text-slate-400">{option.sample}</div>
							</div>
						</Radio>
					);
				})}
			</div>
		</Radio.Group>
	);
}
