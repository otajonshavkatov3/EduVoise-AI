import { EditOutlined, UserOutlined } from "@ant-design/icons";
import { Avatar, Button, Form, Input, Modal, Select } from "antd";
import { useEffect } from "react";
import { useUpdateOperator } from "../hooks/useOperators";
import type { OperatorProfile, UpdateOperatorRequest } from "../types";
import { operatorStatusConfig } from "./OperatorStatusTag";

interface Props {
	open: boolean;
	operator: OperatorProfile | null;
	onCancel: () => void;
}

export function OperatorEditModal({ open, operator, onCancel }: Props) {
	const [form] = Form.useForm();
	const updateOperator = useUpdateOperator();

	useEffect(() => {
		if (operator) {
			form.setFieldsValue({
				extension: operator.extension,
				status: operator.currentStatus,
			});
		}
	}, [operator, form]);

	const handleSubmit = async (values: UpdateOperatorRequest) => {
		if (!operator) {
			return;
		}
		try {
			await updateOperator.mutateAsync({ id: operator.id, data: values });
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
					<span className="font-extrabold text-slate-900 uppercase tracking-tight">
						Operator profilini tahrirlash
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
			<Form form={form} layout="vertical" onFinish={handleSubmit} className="mt-6">
				<Form.Item label={<span className="font-bold text-slate-700">Operator</span>}>
					<div className="p-4 bg-slate-50 border border-slate-100 rounded-2xl flex items-center gap-3">
						<Avatar
							icon={<UserOutlined />}
							className="bg-white text-slate-400 border border-slate-200"
						/>
						<div>
							<div className="font-bold text-slate-900">
								{operator?.user?.phone ?? "Noma'lum foydalanuvchi"}
							</div>
							<div className="text-xs text-slate-400 capitalize">{operator?.user?.role ?? "—"}</div>
						</div>
					</div>
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

				<Form.Item
					name="status"
					label={<span className="font-bold text-slate-700">Holatni majburan o'zgartirish</span>}
				>
					<Select
						className="h-11 rounded-xl"
						options={Object.entries(operatorStatusConfig).map(([val, cfg]) => ({
							label: cfg.label,
							value: val,
						}))}
					/>
				</Form.Item>

				<div className="flex gap-3 pt-6 mt-6 border-t border-slate-100">
					<Button className="flex-1 h-12 rounded-xl font-bold" onClick={onCancel}>
						Bekor qilish
					</Button>
					<Button
						type="primary"
						htmlType="submit"
						className="flex-1 h-12 rounded-xl font-bold shadow-lg shadow-blue-500/20"
						loading={updateOperator.isPending}
					>
						Saqlash
					</Button>
				</div>
			</Form>
		</Modal>
	);
}
