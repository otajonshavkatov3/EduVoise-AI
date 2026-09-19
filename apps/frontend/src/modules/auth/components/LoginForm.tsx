import { LockOutlined, PhoneOutlined } from "@ant-design/icons";
import { Button, Form, Input } from "antd";
import { PhoneInput } from "../../../shared/components/ui";
import { useLogin } from "../hooks/useAuth";
import type { LoginRequest } from "../types";
import { LoginFooter } from "./LoginFooter";
import { LoginHeader } from "./LoginHeader";

/**
 * Kirish formasi.
 *
 * Bu yerda avval `LoginActions` bloki bo'lgan: "Remember me" belgisi hech qanday
 * qiymatga bog'lanmagan (tokenlar baribir localStorage'da saqlanadi) va "Forgot
 * password?" havolasi `/` ga olib borardi — parolni tiklash endpointi umuman
 * yo'q. Ikkalasi ham ishlayotgandek ko'rinib, hech narsa qilmagani uchun olib
 * tashlandi.
 *
 * Parol uzunligi chegarasi backend `LoginSchema` bilan bir xil (kamida 4):
 * avval frontend 6 talab qilardi va 4-5 belgili haqiqiy parol bilan kirishga
 * yo'l qo'ymasdi.
 */
export function LoginForm() {
	const [form] = Form.useForm<LoginRequest>();
	const { mutate: login, isPending } = useLogin();

	const onFinish = (values: LoginRequest) => {
		login(values);
	};

	return (
		<div className="w-full">
			<LoginHeader />

			<Form
				form={form}
				name="login"
				onFinish={onFinish}
				layout="vertical"
				requiredMark={false}
				size="large"
				className="space-y-4"
			>
				<Form.Item
					name="phone"
					label={<span className="font-medium text-gray-600">Telefon raqami</span>}
					rules={[
						{ required: true, message: "Telefon raqamini kiriting" },
						{
							pattern: /^\+998\d{9}$/,
							message: "Format: +998 va 9 raqam",
						},
					]}
				>
					<PhoneInput
						prefix={<PhoneOutlined className="text-gray-400" />}
						className="h-12 rounded-xl border-gray-200 shadow-sm transition-all hover:border-blue-400 focus:border-blue-500"
					/>
				</Form.Item>

				<Form.Item
					name="password"
					label={<span className="font-medium text-gray-600">Parol</span>}
					rules={[
						{ required: true, message: "Parolni kiriting" },
						{ min: 4, message: "Parol kamida 4 belgidan iborat bo'lishi kerak" },
					]}
				>
					<Input.Password
						prefix={<LockOutlined className="text-gray-400" />}
						placeholder="••••••••"
						autoComplete="current-password"
						className="h-12 rounded-xl border-gray-200 shadow-sm transition-all hover:border-blue-400 focus:border-blue-500"
					/>
				</Form.Item>

				<Form.Item className="mt-8!">
					<Button
						type="primary"
						htmlType="submit"
						loading={isPending}
						block
						className="h-12 rounded-xl bg-blue-600 text-base font-bold shadow-lg shadow-blue-200 hover:bg-blue-700"
					>
						Kirish
					</Button>
				</Form.Item>
			</Form>

			<LoginFooter />
		</div>
	);
}
