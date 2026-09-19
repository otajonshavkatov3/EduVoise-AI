import {
	ApiOutlined,
	CheckCircleOutlined,
	CloseCircleOutlined,
	DesktopOutlined,
	LoadingOutlined,
	LockOutlined,
	PhoneOutlined,
	SaveOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import { Alert, App, Button, Card, Col, Form, Input, Row, Select, Space, Switch, Tag } from "antd";
import type { ReactNode } from "react";

import type { SipConfig } from "@/modules/calls/config/sip.config";
import { useSipPhoneContext } from "@/modules/calls/providers/SipPhoneProvider";
import type { SipConnectionStatus } from "@/modules/calls/store/sip.store";

/**
 * The web phone's SIP account. Unlike everything else on this page this is NOT a
 * server setting: it is stored in this browser's localStorage (see
 * modules/calls/config/sip.config.ts) because a SIP extension belongs to the
 * device an operator is sitting at, not to the platform. Saving here also
 * re-registers the phone, which is why the button says "Saqlash va Ulanish".
 */

interface StatusPresentation {
	color: string;
	icon: ReactNode;
	label: string;
	dotClass: string;
}

const STATUS_PRESENTATION: Record<SipConnectionStatus, StatusPresentation> = {
	disconnected: {
		color: "default",
		icon: <CloseCircleOutlined />,
		label: "Uzilgan",
		dotClass: "bg-slate-400",
	},
	connecting: {
		color: "processing",
		icon: <LoadingOutlined spin />,
		label: "Ulanmoqda...",
		dotClass: "bg-amber-400 animate-pulse",
	},
	connected: {
		color: "warning",
		icon: <ApiOutlined />,
		label: "Ulangan",
		dotClass: "bg-amber-500",
	},
	registered: {
		color: "success",
		icon: <CheckCircleOutlined />,
		label: "Ro'yxatdan o'tgan",
		dotClass: "bg-emerald-500 animate-pulse",
	},
	error: {
		color: "error",
		icon: <WarningOutlined />,
		label: "Xato",
		dotClass: "bg-rose-500",
	},
};

/** Only the fields this form owns; the rest of SipConfig is left untouched. */
type SipFormValues = Pick<
	SipConfig,
	"serverIp" | "wsPort" | "wsProtocol" | "extension" | "password" | "autoConnect"
>;

function FieldLabel({ children }: { children: string }) {
	return <span className="font-bold text-slate-700">{children}</span>;
}

export function SipDeviceSettings() {
	const { message } = App.useApp();
	const { config, connectionStatus, isRegistered, errorMessage, connect, disconnect, setConfig } =
		useSipPhoneContext();

	const [form] = Form.useForm<SipFormValues>();
	const status = STATUS_PRESENTATION[connectionStatus];

	const handleFinish = async (values: SipFormValues) => {
		setConfig(values);
		// connect() persists the override to localStorage, which is what makes this
		// section survive a reload.
		await connect(values);
		message.success("SIP sozlamalari shu brauzerda saqlandi va ulanish boshlandi");
	};

	const handleDisconnect = async () => {
		await disconnect();
		message.info("SIP serverdan uzildi");
	};

	return (
		<Card
			className="border-none shadow-sm rounded-2xl overflow-hidden"
			title={
				<div className="flex flex-wrap items-center justify-between gap-3 py-1">
					<div className="flex items-center gap-3">
						<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
							<PhoneOutlined />
						</div>
						<div>
							<div className="mb-1 text-sm font-black leading-none text-slate-900">
								Web Telefon (SIP)
							</div>
							<div className="text-[9px] font-bold uppercase leading-none tracking-widest text-slate-400">
								Faqat shu qurilma uchun
							</div>
						</div>
					</div>
					<div className="flex flex-col items-end gap-2">
						<Tag
							color={status.color}
							icon={status.icon}
							className="flex items-center gap-2 rounded-full border-none px-4 py-1 text-xs font-bold"
						>
							<div className={`h-2 w-2 rounded-full ${status.dotClass}`} />
							{status.label}
						</Tag>
						{isRegistered && (
							<span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">
								Extension {config.extension} faol
							</span>
						)}
					</div>
				</div>
			}
		>
			<Alert
				type="info"
				showIcon
				icon={<DesktopOutlined />}
				className="mb-5 rounded-xl border-blue-100 bg-blue-50"
				title={
					<span className="font-bold text-blue-600">
						Bu sozlamalar serverga yuborilmaydi — brauzer xotirasida (localStorage) saqlanadi
					</span>
				}
				description={
					<span className="text-slate-600">
						Har bir operator o'z kompyuterida o'z extensionini kiritadi. Boshqa qurilmada qaytadan
						kiritish kerak bo'ladi.
					</span>
				}
			/>

			{errorMessage && (
				<Alert
					type="error"
					showIcon
					className="mb-5 rounded-xl border-rose-200 bg-rose-50"
					title={<span className="font-bold text-rose-600">{errorMessage}</span>}
				/>
			)}

			<Form form={form} layout="vertical" initialValues={config} onFinish={handleFinish}>
				<Row gutter={20}>
					<Col xs={24} md={18}>
						<Form.Item
							label={<FieldLabel>SIP server IP / domen</FieldLabel>}
							name="serverIp"
							rules={[{ required: true, message: "Server manzilini kiriting" }]}
						>
							<Input placeholder="127.0.0.1" className="h-11 rounded-xl" />
						</Form.Item>
					</Col>
					<Col xs={24} md={6}>
						<Form.Item
							label={<FieldLabel>WS port</FieldLabel>}
							name="wsPort"
							rules={[{ required: true, message: "Portni kiriting" }]}
						>
							<Input placeholder="8088" className="h-11 rounded-xl" />
						</Form.Item>
					</Col>
				</Row>

				<Row gutter={20}>
					<Col xs={24} md={8}>
						<Form.Item
							label={<FieldLabel>Ichki raqam</FieldLabel>}
							name="extension"
							rules={[{ required: true, message: "Ichki raqamni kiriting" }]}
						>
							<Input placeholder="101" className="h-11 rounded-xl" />
						</Form.Item>
					</Col>
					<Col xs={24} md={8}>
						<Form.Item
							label={<FieldLabel>SIP parol</FieldLabel>}
							name="password"
							rules={[{ required: true, message: "Parolni kiriting" }]}
						>
							<Input.Password
								prefix={<LockOutlined className="text-slate-300" />}
								placeholder="••••••••"
								className="h-11 rounded-xl"
							/>
						</Form.Item>
					</Col>
					<Col xs={24} md={8}>
						<Form.Item label={<FieldLabel>Protokol</FieldLabel>} name="wsProtocol">
							<Select
								className="custom-select h-11 w-full"
								options={[
									{ value: "ws", label: "WS (shifrlanmagan)" },
									{ value: "wss", label: "WSS (xavfsiz)" },
								]}
							/>
						</Form.Item>
					</Col>
				</Row>

				<div className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-4">
					<div>
						<div className="text-sm font-bold text-slate-900">Avtomatik ulanish</div>
						<div className="text-xs text-slate-500">
							Ilova yuklanganda va operator holati «onlayn» bo'lganda o'zi ulanadi
						</div>
					</div>
					<Form.Item name="autoConnect" valuePropName="checked" noStyle>
						<Switch />
					</Form.Item>
				</div>

				<Space size="middle" wrap>
					<Button
						type="primary"
						htmlType="submit"
						icon={<SaveOutlined />}
						className="h-11 rounded-xl px-6 font-bold shadow-lg shadow-blue-500/20"
					>
						Saqlash va ulanish
					</Button>

					{connectionStatus !== "disconnected" && (
						<Button
							danger
							icon={<CloseCircleOutlined />}
							onClick={handleDisconnect}
							className="h-11 rounded-xl px-6 font-bold"
						>
							Ulanishni uzish
						</Button>
					)}
				</Space>
			</Form>
		</Card>
	);
}
