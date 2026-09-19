import { KeyOutlined, LockOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuthStore } from "@/modules/auth/store/auth.store";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useChangePassword } from "../hooks/useProfile";

interface FormValues {
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
}

/**
 * Parolni o'zgartirish.
 *
 * Backend muvaffaqiyatdan keyin foydalanuvchining BARCHA refresh tokenlarini
 * bekor qiladi — bu ataylab, chunki oshkor bo'lgan parolni almashtirish eski
 * tokenlar ishlab turgan holda hech narsani himoya qilmaydi. Ya'ni joriy sessiya
 * ham o'ladi, shuning uchun bu komponent lokal holatni tozalab, foydalanuvchini
 * login sahifasiga yuboradi. Aks holda keyingi so'rov tushunarsiz 401 beradi.
 */
export function ChangePasswordCard() {
	const [form] = Form.useForm<FormValues>();
	const [done, setDone] = useState(false);
	const navigate = useNavigate();
	const clearAuth = useAuthStore((state) => state.logout);
	const { mutate, isPending, isError, error } = useChangePassword();

	const handleFinish = (values: FormValues) => {
		mutate(
			{ currentPassword: values.currentPassword, newPassword: values.newPassword },
			{
				onSuccess: () => {
					setDone(true);
					form.resetFields();
					// Short pause so the success notice is actually readable before the
					// redirect takes the page away.
					setTimeout(() => {
						clearAuth();
						navigate("/login", { replace: true });
					}, 2200);
				},
			}
		);
	};

	return (
		<Card
			className="xl:col-span-12"
			title={
				<div className="flex items-center gap-2 font-bold text-[#0f172a]">
					<KeyOutlined className="text-[#2154b2]" />
					Parolni o'zgartirish
				</div>
			}
		>
			{done ? (
				<Alert
					type="success"
					showIcon
					className="rounded-2xl"
					message="Parol o'zgartirildi"
					description="Xavfsizlik uchun barcha qurilmalardagi sessiyalar bekor qilindi. Bir necha soniyadan so'ng kirish sahifasiga o'tasiz."
				/>
			) : (
				<>
					<Typography.Paragraph className="mb-5 text-[#64748b]">
						Yangi parol kamida 8 belgidan iborat bo'lishi kerak. O'zgartirilgandan so'ng barcha
						qurilmalarda qaytadan kirish talab etiladi.
					</Typography.Paragraph>

					{isError && (
						<Alert
							type="error"
							showIcon
							className="mb-5 rounded-2xl"
							message="Parol o'zgartirilmadi"
							description={getApiErrorMessage(error, "Hozirgi parolni tekshirib ko'ring")}
						/>
					)}

					<Form
						form={form}
						layout="vertical"
						onFinish={handleFinish}
						requiredMark={false}
						disabled={isPending}
					>
						<div className="grid grid-cols-1 gap-x-6 md:grid-cols-3">
							<Form.Item
								name="currentPassword"
								label={<span className="font-semibold text-[#0f172a]">Hozirgi parol</span>}
								rules={[{ required: true, message: "Hozirgi parolni kiriting" }]}
							>
								<Input.Password
									prefix={<LockOutlined className="text-[#64748b]" />}
									placeholder="Hozirgi parol"
									autoComplete="current-password"
									className="h-11 rounded-xl"
								/>
							</Form.Item>

							<Form.Item
								name="newPassword"
								label={<span className="font-semibold text-[#0f172a]">Yangi parol</span>}
								rules={[
									{ required: true, message: "Yangi parolni kiriting" },
									{ min: 8, message: "Kamida 8 belgi" },
								]}
							>
								<Input.Password
									prefix={<LockOutlined className="text-[#64748b]" />}
									placeholder="Yangi parol"
									autoComplete="new-password"
									className="h-11 rounded-xl"
								/>
							</Form.Item>

							<Form.Item
								name="confirmPassword"
								label={
									<span className="font-semibold text-[#0f172a]">Yangi parolni takrorlang</span>
								}
								dependencies={["newPassword"]}
								rules={[
									{ required: true, message: "Parolni takrorlang" },
									// Validated here as well as on the server: catching a typo before
									// the request avoids revoking every session for nothing.
									({ getFieldValue }) => ({
										validator(_rule, value) {
											if (!value || getFieldValue("newPassword") === value) {
												return Promise.resolve();
											}
											return Promise.reject(new Error("Parollar mos kelmadi"));
										},
									}),
								]}
							>
								<Input.Password
									prefix={<LockOutlined className="text-[#64748b]" />}
									placeholder="Takrorlang"
									autoComplete="new-password"
									className="h-11 rounded-xl"
								/>
							</Form.Item>
						</div>

						<Button
							type="primary"
							htmlType="submit"
							loading={isPending}
							className="h-11 rounded-xl px-6 font-bold"
						>
							Parolni o'zgartirish
						</Button>
					</Form>
				</>
			)}
		</Card>
	);
}
