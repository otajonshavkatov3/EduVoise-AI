import { EnvironmentOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal } from "antd";
import { PhoneInput } from "@/shared/components/ui/PhoneInput";
import { useCreateContact } from "../hooks/useContacts";
import type { CreateContactRequest } from "../types";

interface Props {
	open: boolean;
	onCancel: () => void;
}

export function ContactCreateModal({ open, onCancel }: Props) {
	const [form] = Form.useForm();
	const createContact = useCreateContact();

	const handleSubmit = async (values: CreateContactRequest) => {
		try {
			await createContact.mutateAsync(values);
			onCancel();
			form.resetFields();
		} catch {
			// Handled by hook
		}
	};

	return (
		<Modal
			title={
				<div className="flex items-center gap-2 pb-2">
					<PlusOutlined className="text-blue-600" />
					<span className="font-extrabold text-slate-900 uppercase tracking-tight">
						Yangi kontakt qo'shish
					</span>
				</div>
			}
			open={open}
			onCancel={onCancel}
			footer={null}
			width={600}
			centered
			styles={{ mask: { backdropFilter: "blur(4px)" } }}
		>
			<Form
				form={form}
				layout="vertical"
				onFinish={handleSubmit}
				className="mt-6"
				initialValues={{ address: { tuman: "", kocha: "", uy: "" } }}
			>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
					<Form.Item name="firstName" label={<span className="font-bold text-slate-700">Ism</span>}>
						<Input placeholder="e.g. Ali" className="h-11 rounded-xl shadow-sm" />
					</Form.Item>

					<Form.Item
						name="lastName"
						label={<span className="font-bold text-slate-700">Familiya</span>}
					>
						<Input placeholder="e.g. Karimov" className="h-11 rounded-xl shadow-sm" />
					</Form.Item>

					<Form.Item
						name="phoneNumber"
						label={<span className="font-bold text-slate-700">Telefon raqami</span>}
						rules={[{ required: true, message: "Telefon raqami kiritilishi shart" }]}
						className="md:col-span-2"
					>
						<PhoneInput className="h-11 rounded-xl shadow-sm" />
					</Form.Item>
				</div>

				<div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 mb-6 mt-2 shadow-inner">
					<h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
						<EnvironmentOutlined /> Manzil ma'lumotlari
					</h4>
					<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
						<Form.Item
							name={["address", "tuman"]}
							label={<span className="text-xs font-bold text-slate-600">Tuman</span>}
						>
							<Input placeholder="Tuman nomi" className="h-10 rounded-lg" />
						</Form.Item>
						<Form.Item
							name={["address", "kocha"]}
							label={<span className="text-xs font-bold text-slate-600">Ko'cha</span>}
						>
							<Input placeholder="Ko'cha nomi" className="h-10 rounded-lg" />
						</Form.Item>
						<Form.Item
							name={["address", "uy"]}
							label={<span className="text-xs font-bold text-slate-600">Uy raqami</span>}
						>
							<Input placeholder="Uy" className="h-10 rounded-lg" />
						</Form.Item>
					</div>
				</div>

				<Form.Item
					name="notes"
					label={<span className="font-bold text-slate-700">Eslatmalar</span>}
				>
					<Input.TextArea
						placeholder="Kontakt haqida qo'shimcha ma'lumotlar..."
						rows={3}
						className="rounded-xl p-3 shadow-sm"
					/>
				</Form.Item>

				<div className="flex gap-3 pt-6 mt-4 border-t border-slate-100">
					<Button className="flex-1 h-12 rounded-xl font-bold" onClick={onCancel}>
						Bekor qilish
					</Button>
					<Button
						type="primary"
						htmlType="submit"
						className="flex-1 h-12 rounded-xl font-bold shadow-lg shadow-blue-500/20"
						loading={createContact.isPending}
					>
						Kontaktni saqlash
					</Button>
				</div>
			</Form>
		</Modal>
	);
}
