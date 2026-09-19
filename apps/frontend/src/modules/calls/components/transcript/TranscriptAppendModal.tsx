import { Form, Input, InputNumber, Modal, Select, Switch } from "antd";
import { useEffect } from "react";
import { useAppendTranscriptLine } from "../../hooks/useTranscripts";
import type { TranscriptRole } from "../../types/transcript";

interface Props {
	open: boolean;
	callId: string;
	/** Pleerning joriy pozitsiyasi (ms) — boshlanish vaqti sifatida taklif etiladi */
	suggestedStartMs: number;
	onClose: () => void;
}

interface FormValues {
	role: TranscriptRole;
	content: string;
	startMs?: number;
	endMs?: number;
	isFinal: boolean;
}

/** Transkriptga qo'lda qator qo'shish (tuzatish/qo'shimcha izoh uchun). */
export function TranscriptAppendModal({ open, callId, suggestedStartMs, onClose }: Props) {
	const [form] = Form.useForm<FormValues>();
	const appendLine = useAppendTranscriptLine(callId);

	useEffect(() => {
		if (open) {
			form.resetFields();
			form.setFieldsValue({
				role: "agent",
				isFinal: true,
				startMs: suggestedStartMs > 0 ? suggestedStartMs : undefined,
			});
		}
	}, [open, suggestedStartMs, form]);

	const handleSubmit = async (values: FormValues) => {
		try {
			await appendLine.mutateAsync({
				role: values.role,
				content: values.content.trim(),
				startMs: values.startMs ?? undefined,
				endMs: values.endMs ?? undefined,
				isFinal: values.isFinal,
			});
			onClose();
		} catch {
			// Xato hook ichida ko'rsatiladi
		}
	};

	return (
		<Modal
			open={open}
			title="Transkriptga qator qo'shish"
			onCancel={onClose}
			onOk={() => form.submit()}
			okText="Qo'shish"
			cancelText="Bekor qilish"
			confirmLoading={appendLine.isPending}
			destroyOnHidden
			centered
		>
			<Form form={form} layout="vertical" onFinish={handleSubmit} requiredMark={false}>
				<Form.Item
					name="role"
					label={
						<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
							Kim gapirdi
						</span>
					}
					rules={[{ required: true, message: "Rolni tanlang" }]}
				>
					<Select
						className="h-12 w-full custom-select"
						options={[
							{ value: "caller", label: "Mijoz" },
							{ value: "agent", label: "Operator / AI" },
							{ value: "system", label: "Tizim" },
						]}
					/>
				</Form.Item>

				<Form.Item
					name="content"
					label={
						<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
							Matn
						</span>
					}
					rules={[{ required: true, message: "Matn kiritilishi shart" }]}
				>
					<Input.TextArea
						rows={4}
						maxLength={10000}
						showCount
						className="rounded-xl border-slate-200 bg-slate-50 font-medium text-slate-900"
					/>
				</Form.Item>

				<div className="flex gap-4">
					<Form.Item
						name="startMs"
						label={
							<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
								Boshlanish (ms)
							</span>
						}
						className="flex-1"
					>
						<InputNumber
							min={0}
							step={100}
							className="h-12 w-full rounded-xl border-slate-200 bg-slate-50"
							placeholder="0"
						/>
					</Form.Item>
					<Form.Item
						name="endMs"
						label={
							<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
								Tugash (ms)
							</span>
						}
						className="flex-1"
					>
						<InputNumber
							min={0}
							step={100}
							className="h-12 w-full rounded-xl border-slate-200 bg-slate-50"
							placeholder="0"
						/>
					</Form.Item>
				</div>

				<Form.Item
					name="isFinal"
					valuePropName="checked"
					label={
						<span className="text-[11px] font-black uppercase tracking-wider text-slate-800">
							Yakunlangan qator
						</span>
					}
				>
					<Switch />
				</Form.Item>
			</Form>
		</Modal>
	);
}
