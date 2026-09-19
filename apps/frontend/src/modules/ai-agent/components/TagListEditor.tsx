import { PlusOutlined } from "@ant-design/icons";
import { Button, Input, Tag } from "antd";
import { useState } from "react";

interface Props {
	/** antd Form.Item bilan ishlashi uchun ixtiyoriy — u boshida undefined uzatadi. */
	value?: string[];
	onChange?: (next: string[]) => void;
	disabled?: boolean;
	placeholder?: string;
	/** Ro'yxat bo'sh bo'lganda ko'rsatiladigan izoh. */
	emptyHint?: string;
	/** Kiritilgan qiymatni saqlashdan oldin o'zgartirish (masalan kichik harfga). */
	normalize?: (raw: string) => string;
	maxItems?: number;
	color?: string;
}

/**
 * Qo'shib-o'chirib turiladigan teg ro'yxati.
 *
 * Murojaat turlari, uzatish extensionlari va qo'shimcha tillar uchun ishlatiladi:
 * biznes egasi uchun "Select mode=tags" dan tushunarliroq — har bir element
 * ko'rinib turadi va kresti bilan o'chiriladi.
 */
export function TagListEditor({
	value,
	onChange,
	disabled = false,
	placeholder,
	emptyHint,
	normalize,
	maxItems = 50,
	color = "blue",
}: Props) {
	const [draft, setDraft] = useState("");
	const items = value ?? [];

	const commit = () => {
		const raw = draft.trim();

		if (raw.length === 0) {
			return;
		}

		const next = normalize ? normalize(raw) : raw;

		if (next.length === 0 || items.includes(next) || items.length >= maxItems) {
			setDraft("");
			return;
		}

		onChange?.([...items, next]);
		setDraft("");
	};

	const remove = (item: string) => {
		onChange?.(items.filter((current) => current !== item));
	};

	return (
		<div>
			<div className="mb-2 flex flex-wrap gap-2">
				{items.length === 0 && (
					<span className="text-xs italic text-slate-400">{emptyHint ?? "Ro'yxat bo'sh"}</span>
				)}
				{items.map((item) => (
					<Tag
						key={item}
						color={color}
						closable={!disabled}
						onClose={(event) => {
							event.preventDefault();
							remove(item);
						}}
						className="m-0 rounded-lg border-none px-3 py-1 text-xs font-bold"
					>
						{item}
					</Tag>
				))}
			</div>

			{!disabled && (
				<div className="flex gap-2">
					<Input
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onPressEnter={(event) => {
							event.preventDefault();
							commit();
						}}
						placeholder={placeholder ?? "Yozing va Enter bosing"}
						maxLength={60}
						className="h-10 rounded-xl border-slate-200 bg-slate-50"
					/>
					<Button
						icon={<PlusOutlined />}
						onClick={commit}
						disabled={draft.trim().length === 0}
						className="h-10 shrink-0 rounded-xl px-4 font-bold"
					>
						Qo'shish
					</Button>
				</div>
			)}
		</div>
	);
}
