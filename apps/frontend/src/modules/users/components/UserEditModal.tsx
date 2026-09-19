import { EditOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, Select, Switch } from "antd";
import { useEffect } from "react";
import { PhoneInput } from "@/shared/components/ui/PhoneInput";
import { useUpdateUser } from "../hooks/useUsers";
import type { UpdateUserRequest, User } from "../types";

interface Props {
	open: boolean;
	user: User | null;
	onCancel: () => void;
}

export function UserEditModal({ open, user, onCancel }: Props) {
	const [form] = Form.useForm<UpdateUserRequest>();
	const updateUser = useUpdateUser();

	useEffect(() => {
		if (user) {
			form.setFieldsValue({
				phone: user.phone,
				username: user.username,
				email: user.email,
				role: user.role,
				isActive: user.isActive,
			});
		}
	}, [user, form]);

	const handleUpdate = async (values: UpdateUserRequest) => {
		if (!user) {
			return;
		}
		try {
			await updateUser.mutateAsync({ id: user.id, data: values });
			onCancel();
		} catch {
			// Xabar mutation hookida ko'rsatiladi
		}
	};

	return (
		<Modal
			title={
				<div className="flex items-center gap-2 pb-2">
					<EditOutlined className="text-blue-600" />
					<span className="font-extrabold uppercase tracking-tight text-slate-900">
						Foydalanuvchini tahrirlash
					</span>
				</div>
			}
			open={open}
			onCancel={onCancel}
			footer={null}
			width={500}
			centered
			styles={{ mask: { backdropFilter: "blur(4px)" } }}
		>
			<Form
				form={form}
				layout="vertical"
				onFinish={handleUpdate}
				initialValues={{ isActive: true }}
				className="mt-6"
			>
				<div className="grid grid-cols-1 gap-y-4">
					<Form.Item
						name="username"
						label={<span className="font-bold text-slate-700">Foydalanuvchi nomi</span>}
						rules={[{ max: 50, message: "Nom juda uzun" }]}
					>
						<Input placeholder="Masalan: Aziz Karimov" className="h-11 rounded-xl shadow-sm" />
					</Form.Item>

					<Form.Item
						name="phone"
						label={<span className="font-bold text-slate-700">Telefon raqami</span>}
						rules={[
							{ required: true, message: "Telefon raqamini kiriting" },
							{
								pattern: /^\+998\d{9}$/,
								message: "To'liq raqam kiriting: +998 va 9 raqam",
							},
						]}
					>
						<PhoneInput className="h-11 rounded-xl shadow-sm" />
					</Form.Item>

					<Form.Item
						name="email"
						label={<span className="font-bold text-slate-700">Elektron pochta</span>}
						rules={[{ type: "email", message: "Elektron pochta formati noto'g'ri" }]}
					>
						<Input placeholder="user@example.com" className="h-11 rounded-xl shadow-sm" />
					</Form.Item>

					<div className="grid grid-cols-2 gap-4">
						{/* Rollar backenddagi `user_role` enum bilan bir xil bo'lishi shart —
						    "operator" varianti bu yerda bor edi, lekin server uni qabul
						    qilmaydi va so'rov 400 bilan tugardi. */}
						<Form.Item
							name="role"
							label={<span className="font-bold text-slate-700">Roli</span>}
							rules={[{ required: true, message: "Rolni tanlang" }]}
						>
							<Select className="custom-select h-11 w-full" placeholder="Rolni tanlang">
								<Select.Option value="supervisor">Nazoratchi</Select.Option>
								<Select.Option value="admin">Administrator</Select.Option>
								<Select.Option value="manager">Menejer</Select.Option>
							</Select>
						</Form.Item>

						{/* Switch to'g'ridan-to'g'ri Form.Item ichida: avval u divga
						    o'ralgan edi va `checked`/`onChange` Switchga yetib bormay,
						    holat hech qachon formaga bog'lanmagan. */}
						<Form.Item
							name="isActive"
							label={<span className="font-bold text-slate-700">Holati</span>}
							valuePropName="checked"
						>
							<Switch checkedChildren="Faol" unCheckedChildren="Nofaol" />
						</Form.Item>
					</div>
				</div>

				<div className="mt-6 flex gap-3 border-t border-slate-100 pt-6">
					<Button className="h-12 flex-1 rounded-xl font-bold" onClick={onCancel}>
						Bekor qilish
					</Button>
					<Button
						type="primary"
						htmlType="submit"
						className="h-12 flex-1 rounded-xl font-bold shadow-lg shadow-blue-500/20"
						loading={updateUser.isPending}
					>
						Saqlash
					</Button>
				</div>
			</Form>
		</Modal>
	);
}
