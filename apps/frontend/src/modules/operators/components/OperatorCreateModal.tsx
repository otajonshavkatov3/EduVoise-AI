import { PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, Modal, Select, Spin } from "antd";
import { useUsers } from "@/modules/users/hooks/useUsers";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useCreateOperator } from "../hooks/useOperators";
import type { CreateOperatorRequest } from "../types";

interface Props {
	open: boolean;
	onCancel: () => void;
}

export function OperatorCreateModal({ open, onCancel }: Props) {
	const [form] = Form.useForm<CreateOperatorRequest>();
	const createOperator = useCreateOperator();
	const {
		data: usersData,
		isLoading: isUsersLoading,
		isError: isUsersError,
		error: usersError,
	} = useUsers({ limit: 100 });

	const users = usersData?.data.items ?? [];

	const handleClose = () => {
		form.resetFields();
		onCancel();
	};

	const handleSubmit = async (values: CreateOperatorRequest) => {
		try {
			await createOperator.mutateAsync(values);
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
						Operator profili qo'shish
					</span>
				</div>
			}
			open={open}
			onCancel={handleClose}
			footer={null}
			width={500}
			centered
			styles={{ mask: { backdropFilter: "blur(4px)" } }}
		>
			{isUsersError && (
				<Alert
					type="error"
					showIcon
					className="mt-4 rounded-xl"
					message="Foydalanuvchilar ro'yxatini yuklab bo'lmadi"
					description={getApiErrorMessage(
						usersError,
						"Ro'yxat kelmagani uchun operator tayinlash mumkin emas"
					)}
				/>
			)}

			<Form form={form} layout="vertical" onFinish={handleSubmit} className="mt-6">
				<Form.Item
					name="userId"
					label={<span className="font-bold text-slate-700">Foydalanuvchini tanlang</span>}
					rules={[{ required: true, message: "Foydalanuvchini tanlang" }]}
				>
					<Select
						className="custom-select h-11"
						placeholder="Ichki raqam beriladigan foydalanuvchi"
						showSearch
						optionFilterProp="children"
						loading={isUsersLoading}
						disabled={isUsersError}
						notFoundContent={
							isUsersLoading ? (
								<div className="py-4 text-center">
									<Spin size="small" />
								</div>
							) : (
								<Empty
									image={Empty.PRESENTED_IMAGE_SIMPLE}
									description="Foydalanuvchi topilmadi"
									className="py-4"
								/>
							)
						}
					>
						{users.map((user) => (
							<Select.Option key={user.id} value={user.id}>
								{user.phone} ({user.username || "nomsiz"})
							</Select.Option>
						))}
					</Select>
				</Form.Item>

				<Form.Item
					name="extension"
					label={<span className="font-bold text-slate-700">Ichki raqam</span>}
					rules={[
						{ required: true, message: "Ichki raqamni kiriting" },
						{ max: 10, message: "Ichki raqam juda uzun" },
					]}
				>
					<Input placeholder="Masalan: 101" className="h-11 rounded-xl" />
				</Form.Item>

				<div className="mt-6 flex gap-3 border-t border-slate-100 pt-6">
					<Button className="h-12 flex-1 rounded-xl font-bold" onClick={handleClose}>
						Bekor qilish
					</Button>
					<Button
						type="primary"
						htmlType="submit"
						className="h-12 flex-1 rounded-xl font-bold shadow-lg shadow-blue-500/20"
						loading={createOperator.isPending}
						disabled={isUsersError}
					>
						Tayinlash
					</Button>
				</div>
			</Form>
		</Modal>
	);
}
