import { Alert, App, Form, Input, InputNumber, Modal, Switch } from "antd";
import { useEffect, useRef } from "react";
import { TagListEditor } from "@/modules/ai-agent/components/TagListEditor";
import { useCreateKnowledgeEntry, useUpdateKnowledgeEntry } from "../hooks/useKnowledgeBase";
import type { KnowledgeBaseEntry, UpdateKnowledgeEntryRequest } from "../types";

interface Props {
	open: boolean;
	/** Tahrirlash uchun mavjud yozuv; bo'lmasa yangi yaratiladi. */
	entry?: KnowledgeBaseEntry | null;
	/** Sinov panelidan kelgan savol — darhol to'ldirib beriladi. */
	defaultQuestion?: string;
	/** Yangi yozuv qaysi profilga tushishi. Berilmasa — aktiv profil. */
	profileId?: string;
	onClose: () => void;
}

interface FormValues {
	question: string;
	answer: string;
	tags?: string[];
	priority?: number;
	isActive?: boolean;
}

function Label({ children }: { children: string }) {
	return (
		<span className="text-[11px] font-black tracking-wider text-slate-800 uppercase">
			{children}
		</span>
	);
}

function sameTags(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Bitta savol-javob.
 *
 * «Javob» — AI mijozga aytadigan aynan matn, shuning uchun modalda ogohlantirish
 * turadi: narx yoki muddat yozilsa, u o'zgarganda shu yerni yangilash kerak.
 */
export function KnowledgeEntryModal({ open, entry, defaultQuestion, profileId, onClose }: Props) {
	const { message } = App.useApp();
	const [form] = Form.useForm<FormValues>();
	const createEntry = useCreateKnowledgeEntry();
	const updateEntry = useUpdateKnowledgeEntry();

	const isEdit = Boolean(entry);

	/**
	 * Mazmun bo'yicha imzo — obyekt havolasi bo'yicha emas.
	 *
	 * Effekt havolaga bog'langanda, yozuv qatori qayta so'ralishi bilanoq shakl
	 * tozalanib, yozilayotgan matn yo'qolardi. Imzo o'zgarmasa — hech narsa
	 * qaytadan to'ldirilmaydi.
	 */
	const seedSignature = JSON.stringify(
		entry
			? {
					id: entry.id,
					question: entry.question,
					answer: entry.answer,
					tags: entry.tags,
					priority: entry.priority,
					isActive: entry.isActive,
				}
			: { question: defaultQuestion ?? "" }
	);
	const seededSignature = useRef<string | null>(null);

	useEffect(() => {
		if (!open) {
			// Modal `destroyOnHidden` bilan yopiladi — keyingi ochilishda qaytadan
			// to'ldirilishi kerak.
			seededSignature.current = null;
			return;
		}

		if (seededSignature.current === seedSignature) {
			return;
		}

		seededSignature.current = seedSignature;
		form.resetFields();

		if (entry) {
			form.setFieldsValue({
				question: entry.question,
				answer: entry.answer,
				tags: entry.tags,
				priority: entry.priority,
				isActive: entry.isActive,
			});
			return;
		}

		form.setFieldsValue({
			question: defaultQuestion ?? "",
			answer: "",
			tags: [],
			priority: 0,
			isActive: true,
		});
	}, [open, seedSignature, entry, defaultQuestion, form]);

	/**
	 * Tahrirda faqat o'zgargan maydonlar yuboriladi.
	 *
	 * To'liq payload yuborilsa, shu orada boshqa supervisor tuzatgan maydon ham
	 * eski qiymatiga qaytib qolardi.
	 */
	const buildUpdate = (values: FormValues, current: KnowledgeBaseEntry) => {
		const patch: UpdateKnowledgeEntryRequest = {};
		const question = values.question.trim();
		const answer = values.answer.trim();
		const tags = values.tags ?? [];
		const priority = values.priority ?? 0;
		const isActive = values.isActive ?? true;

		if (question !== current.question) {
			patch.question = question;
		}
		if (answer !== current.answer) {
			patch.answer = answer;
		}
		if (!sameTags(tags, current.tags)) {
			patch.tags = tags;
		}
		if (priority !== current.priority) {
			patch.priority = priority;
		}
		if (isActive !== current.isActive) {
			patch.isActive = isActive;
		}

		return patch;
	};

	const handleSubmit = async (values: FormValues) => {
		try {
			if (entry) {
				const patch = buildUpdate(values, entry);

				if (Object.keys(patch).length === 0) {
					message.info("O'zgarish kiritilmadi");
					onClose();
					return;
				}

				await updateEntry.mutateAsync({ id: entry.id, data: patch });
				message.success("Yozuv yangilandi");
			} else {
				await createEntry.mutateAsync({
					profileId,
					question: values.question.trim(),
					answer: values.answer.trim(),
					tags: values.tags ?? [],
					priority: values.priority ?? 0,
					isActive: values.isActive ?? true,
				});
			}

			onClose();
		} catch {
			// Xato hook ichida ko'rsatiladi
		}
	};

	return (
		<Modal
			open={open}
			title={isEdit ? "Yozuvni tahrirlash" : "Yangi savol-javob"}
			onCancel={onClose}
			onOk={() => form.submit()}
			okText={isEdit ? "Saqlash" : "Qo'shish"}
			cancelText="Bekor qilish"
			confirmLoading={createEntry.isPending || updateEntry.isPending}
			destroyOnHidden
			centered
			width={680}
		>
			<Alert
				type="info"
				showIcon
				className="mb-4 rounded-xl border-blue-100 bg-blue-50"
				title={<span className="font-bold text-blue-600">Javob — AI aytadigan aynan matn</span>}
				description={
					<span className="text-slate-600">
						Narx, manzil yoki muddat yozsangiz, AI aynan shuni aytadi. Ular o'zgarganda shu yozuvni
						yangilashni esdan chiqarmang.
					</span>
				}
			/>

			<Form form={form} layout="vertical" onFinish={handleSubmit} requiredMark={false}>
				<Form.Item
					name="question"
					label={<Label>Mijoz qanday so'raydi</Label>}
					rules={[
						{ required: true, message: "Savol kiritilishi shart" },
						// Server ham shu chegarani qo'yadi — bu yerda ushlanmasa 400 qaytadi.
						{ min: 3, message: "Savol kamida 3 belgidan iborat bo'lsin" },
					]}
				>
					<Input.TextArea
						rows={2}
						maxLength={500}
						placeholder="Masalan: ish vaqtingiz qanday? / qachon ochiqsiz?"
						className="rounded-2xl border-slate-200 bg-slate-50"
					/>
				</Form.Item>

				<Form.Item
					name="answer"
					label={<Label>AI nima deydi</Label>}
					rules={[{ required: true, message: "Javob kiritilishi shart" }]}
				>
					<Input.TextArea
						rows={5}
						maxLength={2000}
						showCount
						placeholder="Har kuni 09:00 dan 18:00 gacha ishlaymiz, yakshanba dam olish kuni."
						className="rounded-2xl border-slate-200 bg-slate-50"
					/>
				</Form.Item>

				<Form.Item name="tags" label={<Label>Teglar</Label>}>
					<TagListEditor
						placeholder="ish vaqti"
						emptyHint="Teg yo'q — qidiruvda faqat savol va javob matni ishlatiladi"
						color="blue"
						maxItems={10}
						// Serverdagi chegara: bitta teg 40 belgidan oshmaydi.
						normalize={(raw) => raw.slice(0, 40)}
					/>
				</Form.Item>

				<div className="flex flex-col gap-4 md:flex-row">
					<Form.Item name="priority" label={<Label>Ustuvorlik</Label>} className="flex-1">
						<InputNumber
							min={-100}
							max={100}
							step={1}
							placeholder="0"
							className="h-12 w-full rounded-xl border-slate-200 bg-slate-50"
						/>
					</Form.Item>

					<Form.Item
						name="isActive"
						label={<Label>Yoqilgan</Label>}
						valuePropName="checked"
						className="flex-1"
					>
						<Switch />
					</Form.Item>
				</div>

				<div className="text-xs font-medium text-slate-500">
					Ustuvorlik: bir necha yozuv mos kelsa, kattasi birinchi bo'lib AI ga beriladi. O'chirilgan
					yozuvni AI umuman ko'rmaydi.
				</div>
			</Form>
		</Modal>
	);
}
