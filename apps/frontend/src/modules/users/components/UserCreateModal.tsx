import { PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Modal, Select, Switch } from "antd";
import { PhoneInput } from "@/shared/components/ui/PhoneInput";
import { useCreateUser } from "../hooks/useUsers";
import type { CreateUserRequest } from "../types";

interface Props {
	open: boolean;
	onCancel: () => void;
}

/**
 * Yangi foydalanuvchi yaratish.
 *
 * Backendda bitta "create user" endpointi yo'q, shuning uchun bu forma mavjud
 * ikkita yo'ldan foydalanadi: `POST /auth/register` (telefon + parol) va undan
 * keyin kerak bo'lsa `PATCH /users/{id}` (username, email, rol, holat).
 * Birlashtirish `userService.create` ichida.
 */
export function UserCreateModal({ open, onCancel }: Props) {
	const [form] = Form.useForm<CreateUserRequest>();
	const createUser = useCreateUser();

	const handleClose = () => {
		form.resetFields();
		onCancel();
	};

	const handleSubmit = async (values: CreateUserRequest) => {
		try {
			await createUser.mutateAsync(values);
			handleClose();
		} catch {
			// Xabar mutation hookida ko'rsatiladi
		}
	};

	return (
		<Modal
			title={
				<div className="flex items-center gap-2 pb-2">
					<PlusOutlined className="text-blue-600" />
					<span className="font-extrabold uppercase tracking-tight text-slate-900">
						Yangi foydalanuvchi
					</span>
				</div>
			}
			open={open}
			onCancel={handleClose}
			footer={null}
			width={520}
			centered
			styles={{ mask: { backdropFilter: "blur(4px)" } }}
		>
			<Form
				form={form}
				layout="vertical"
				onFinish={handleSubmit}
				initialValues={{ role: "manager", isActive: true }}
				className="mt-6"
			>
				<Alert
					type="info"
					showIcon
					className="mb-5 rounded-xl"
					message="Foydalanuvchi telefon raqami va parol bilan yaratiladi. Ichki raqam berish uchun keyin «Operatorlar» bo'limida operator profili qo'shiladi."
				/>

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
					name="password"
					label={<span className="font-bold text-slate-700">Parol</span>}
					rules={[
						{ required: true, message: "Parolni kiriting" },
						{ min: 4, message: "Parol kamida 4 belgidan iborat bo'lishi kerak" },
						{ max: 100, message: "Parol juda uzun" },
					]}
				>
					<Input.Password
						placeholder="Kamida 4 belgi"
						autoComplete="new-password"
						className="h-11 rounded-xl shadow-sm"
					/>
				</Form.Item>

				<Form.Item
					name="username"
					label={<span className="font-bold text-slate-700">Foydalanuvchi nomi</span>}
					rules={[{ max: 50, message: "Nom juda uzun" }]}
				>
					<Input placeholder="Masalan: Aziz Karimov" className="h-11 rounded-xl shadow-sm" />
				</Form.Item>

				<Form.Item
					name="email"
					label={<span className="font-bold text-slate-700">Elektron pochta</span>}
					rules={[{ type: "email", message: "Elektron pochta formati noto'g'ri" }]}
				>
					<Input placeholder="user@example.com" className="h-11 rounded-xl shadow-sm" />
				</Form.Item>

				<div className="grid grid-cols-2 gap-4">
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

					{/* Switch to'g'ridan-to'g'ri Form.Item ichida — aks holda `checked`
					    va `onChange` o'ram divga tushib, qiymat formaga bog'lanmaydi. */}
					<Form.Item
						name="isActive"
						label={<span className="font-bold text-slate-700">Holati</span>}
						valuePropName="checked"
					>
						<Switch checkedChildren="Faol" unCheckedChildren="Nofaol" />
					</Form.Item>
				</div>

				<div className="mt-6 flex gap-3 border-t border-slate-100 pt-6">
					<Button className="h-12 flex-1 rounded-xl font-bold" onClick={handleClose}>
						Bekor qilish
					</Button>
					<Button
						type="primary"
						htmlType="submit"
						className="h-12 flex-1 rounded-xl font-bold shadow-lg shadow-blue-500/20"
						loading={createUser.isPending}
					>
						Yaratish
					</Button>
				</div>
			</Form>
		</Modal>
	);
}
