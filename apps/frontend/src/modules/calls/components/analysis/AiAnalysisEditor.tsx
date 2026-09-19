import { CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { Button, Input, Select, Typography } from "antd";
import { useState } from "react";
import type { Sentiment, UpdateAiAnalysisRequest } from "../../types/analysis";
import { CATEGORY_SUGGESTIONS, SENTIMENT_OPTIONS } from "../../utils/analysis";

const { Text } = Typography;

/** Tahrirlanadigan maydonlarning hozirgi qiymati. */
export interface AnalysisDraftSource {
	summary: string | null;
	sentiment: Sentiment | null;
	categories: string[] | null;
}

interface Props {
	current: AnalysisDraftSource;
	isSaving: boolean;
	onSave: (data: UpdateAiAnalysisRequest) => Promise<void>;
	onCancel: () => void;
}

function sameCategories(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

interface Draft {
	summary: string;
	sentiment: Sentiment | undefined;
	categories: string[];
}

/** Faqat o'zgargan maydonlarni yig'adi — audit logda nima tuzatilgani aniq bo'ladi. */
function buildPatch(current: AnalysisDraftSource, draft: Draft): UpdateAiAnalysisRequest {
	const patch: UpdateAiAnalysisRequest = {};
	const trimmed = draft.summary.trim();

	if (trimmed !== (current.summary ?? "")) {
		patch.summary = trimmed.length > 0 ? trimmed : null;
	}
	if ((draft.sentiment ?? null) !== current.sentiment) {
		patch.sentiment = draft.sentiment ?? null;
	}
	if (!sameCategories(draft.categories, current.categories ?? [])) {
		patch.categories = draft.categories.length > 0 ? draft.categories : null;
	}

	return patch;
}

/** AI xulosasini qo'lda tuzatish (TZ 3.8). */
export function AiAnalysisEditor({ current, isSaving, onSave, onCancel }: Props) {
	const [summary, setSummary] = useState(current.summary ?? "");
	const [sentiment, setSentiment] = useState<Sentiment | undefined>(current.sentiment ?? undefined);
	const [categories, setCategories] = useState<string[]>(current.categories ?? []);

	const handleSave = async () => {
		const patch = buildPatch(current, { summary, sentiment, categories });

		if (Object.keys(patch).length === 0) {
			onCancel();
			return;
		}

		await onSave(patch);
	};

	return (
		<div className="space-y-4 rounded-2xl border border-blue-100 bg-blue-50/40 p-4">
			<div>
				<Text className="text-[10px] font-black uppercase tracking-widest text-slate-500">
					Xulosa
				</Text>
				<Input.TextArea
					value={summary}
					onChange={(event) => setSummary(event.target.value)}
					autoSize={{ minRows: 3, maxRows: 10 }}
					maxLength={4000}
					showCount
					placeholder="Qo'ng'iroq mazmunini o'z so'zlaringiz bilan yozing"
					className="mt-1 rounded-2xl border-slate-200 bg-white font-medium text-slate-900"
				/>
				<Text type="secondary" className="text-[11px]">
					Bo'sh qoldirilsa xulosa o'chiriladi — noto'g'ri xulosani saqlab qo'yishdan ko'ra
					yaxshiroq.
				</Text>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<div>
					<Text className="text-[10px] font-black uppercase tracking-widest text-slate-500">
						Kayfiyat
					</Text>
					<Select<Sentiment>
						allowClear
						value={sentiment}
						options={SENTIMENT_OPTIONS}
						onChange={(value) => setSentiment(value ?? undefined)}
						placeholder="Aniqlanmagan"
						className="custom-select mt-1 h-11 w-full"
					/>
				</div>

				<div>
					<Text className="text-[10px] font-black uppercase tracking-widest text-slate-500">
						Kategoriyalar
					</Text>
					<Select<string[]>
						mode="tags"
						value={categories}
						onChange={(value) => setCategories(value.slice(0, 8))}
						options={CATEGORY_SUGGESTIONS.map((item) => ({ value: item, label: item }))}
						placeholder="Yo'l, Suv, Gaz ..."
						maxTagCount={4}
						className="custom-select mt-1 w-full"
					/>
				</div>
			</div>

			<div className="flex justify-end gap-2">
				<Button
					icon={<CloseOutlined />}
					onClick={onCancel}
					disabled={isSaving}
					className="rounded-xl font-bold"
				>
					Bekor qilish
				</Button>
				<Button
					type="primary"
					icon={<CheckOutlined />}
					loading={isSaving}
					onClick={handleSave}
					className="rounded-xl font-bold"
				>
					Saqlash
				</Button>
			</div>
		</div>
	);
}
