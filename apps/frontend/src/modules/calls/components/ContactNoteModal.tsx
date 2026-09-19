import { EditOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, message } from "antd";
import { useEffect } from "react";
import { useUpdateContact } from "@/modules/contacts/hooks/useContacts";

interface ContactNoteModalProps {
	open: boolean;
	onClose: () => void;
	contactId: string;
	initialNote?: string | null;
}

export function ContactNoteModal({ open, onClose, contactId, initialNote }: ContactNoteModalProps) {
	const [form] = Form.useForm();
	const updateContact = useUpdateContact();

	useEffect(() => {
		if (open) {
			form.setFieldsValue({ notes: initialNote });
		}
	}, [open, initialNote, form]);

	const handleSubmit = async (values: { notes: string }) => {
		try {
			await updateContact.mutateAsync({
				id: contactId,
				data: { notes: values.notes },
			});
			message.success("Eslatma saqlandi");
			onClose();
		} catch {
			// Xabar `useUpdateContact` hookida ko'rsatiladi (message.error).
		}
	};

	return (
		<Modal
			title={
				<div className="flex items-center gap-2">
					<EditOutlined className="text-blue-500" />
					<span className="font-bold">Mijoz uchun eslatma</span>
				</div>
			}
			open={open}
			onCancel={onClose}
			footer={null}
			centered
			className="rounded-3xl overflow-hidden"
			styles={{
				mask: { backdropFilter: "blur(4px)" },
				body: { padding: "24px" },
			}}
		>
			<Form form={form} layout="vertical" onFinish={handleSubmit}>
				<Form.Item
					name="notes"
					label={<span className="font-semibold text-slate-600">Eslatma matni</span>}
				>
					<Input.TextArea
						placeholder="Mijoz haqida muhim ma'lumotlarni yozing..."
						rows={5}
						className="rounded-2xl p-4 border-slate-200 focus:border-blue-500!"
					/>
				</Form.Item>
				<div className="flex gap-3 pt-4">
					<Button
						onClick={onClose}
						className="flex-1 h-12 rounded-2xl font-bold border-slate-100 bg-slate-50 text-slate-600"
					>
						Bekor qilish
					</Button>
					<Button
						type="primary"
						htmlType="submit"
						loading={updateContact.isPending}
						className="flex-1 h-12 rounded-2xl font-bold bg-blue-600 shadow-lg shadow-blue-500/20"
					>
						Saqlash
					</Button>
				</div>
			</Form>
		</Modal>
	);
}
