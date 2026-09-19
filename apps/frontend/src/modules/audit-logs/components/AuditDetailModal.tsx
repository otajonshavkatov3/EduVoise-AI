import {
	DesktopOutlined,
	GlobalOutlined,
	HistoryOutlined,
	InfoCircleOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Avatar, Badge, Descriptions, Empty, Modal, Tooltip, Typography } from "antd";
import { formatDateTime } from "@/shared/utils/datetime";
import type { AuditLog } from "../types";
import { auditActionLabel, auditEntityLabel } from "../utils/labels";

const { Text, Title } = Typography;

interface Props {
	log: AuditLog | null;
	open: boolean;
	onCancel: () => void;
}

export function AuditDetailModal({ log, open, onCancel }: Props) {
	return (
		<Modal
			title={
				<div className="flex items-center gap-3 pb-2 border-b border-slate-50">
					<Avatar
						icon={<HistoryOutlined />}
						className="bg-indigo-50 text-indigo-600 border border-indigo-100"
					/>
					<div>
						<div className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none mb-1">
							Audit yozuvi tafsilotlari
						</div>
						<Title level={5} className="m-0 text-slate-900">
							{log ? auditActionLabel(log.action) : ""}
						</Title>
					</div>
				</div>
			}
			open={open}
			onCancel={onCancel}
			footer={null}
			width={700}
			centered
			styles={{ mask: { backdropFilter: "blur(4px)" } }}
		>
			{log ? (
				<div className="mt-6 animate-fadeIn space-y-6">
					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
						<Section title="Hodisa ma'lumotlari" icon={<InfoCircleOutlined />}>
							<Descriptions column={1} size="small" className="mt-2 text-xs">
								<Descriptions.Item label="Harakat">
									<Text strong>{auditActionLabel(log.action)}</Text>
								</Descriptions.Item>
								<Descriptions.Item label="Obyekt turi">
									{log.entityType ? (
										auditEntityLabel(log.entityType)
									) : (
										<Text className="text-xs italic text-slate-400">Ko'rsatilmagan</Text>
									)}
								</Descriptions.Item>
								<Descriptions.Item label="Obyekt ID">
									{log.entityId ? (
										<Text code className="text-[10px]">
											{log.entityId}
										</Text>
									) : (
										<Text className="text-xs italic text-slate-400">Ko'rsatilmagan</Text>
									)}
								</Descriptions.Item>
								<Descriptions.Item label="Vaqt">{formatDateTime(log.createdAt)}</Descriptions.Item>
							</Descriptions>
						</Section>

						<Section title="Manba ma'lumotlari" icon={<GlobalOutlined />}>
							<Descriptions column={1} size="small" className="mt-2 text-xs">
								<Descriptions.Item label="IP manzili">
									{log.ipAddress ? (
										<Badge status="processing" text={log.ipAddress} />
									) : (
										<Text className="text-xs italic text-slate-400">Yozilmagan</Text>
									)}
								</Descriptions.Item>
								<Descriptions.Item label="Brauzer">
									{log.userAgent ? (
										<TooltipText text={log.userAgent} />
									) : (
										<Text className="text-xs italic text-slate-400">Yozilmagan</Text>
									)}
								</Descriptions.Item>
							</Descriptions>
						</Section>
					</div>

					<Section title="Foydalanuvchi" icon={<UserOutlined />}>
						<div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100 mt-2">
							<Avatar
								icon={<UserOutlined />}
								className="bg-white text-indigo-500 border border-indigo-100"
							/>
							<div>
								<div className="text-[10px] uppercase font-black text-slate-400 tracking-wider leading-none mb-1">
									Bajaruvchi
								</div>
								{log.userName ? (
									<div className="font-bold text-slate-900">{log.userName}</div>
								) : (
									<div className="text-xs italic text-slate-400">Aniqlanmagan</div>
								)}
							</div>
						</div>
					</Section>

					{log.details && Object.keys(log.details).length > 0 && (
						<Section title="Qo'shimcha ma'lumot (JSON)" icon={<DesktopOutlined />}>
							<div className="mt-2 p-4 bg-slate-900 rounded-2xl border border-slate-800 shadow-inner max-h-64 overflow-auto">
								<pre className="text-indigo-300 text-[11px] font-mono whitespace-pre-wrap">
									{JSON.stringify(log.details, null, 2)}
								</pre>
							</div>
						</Section>
					)}
				</div>
			) : (
				<Empty
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description="Yozuv tanlanmagan"
					className="py-10"
				/>
			)}
		</Modal>
	);
}

function Section({
	title,
	icon,
	children,
}: {
	title: string;
	icon: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div>
			<h4 className="flex items-center gap-2 text-xs font-black text-slate-900 uppercase tracking-widest border-b border-slate-50 pb-2 mb-2">
				<span className="text-indigo-500">{icon}</span>
				{title}
			</h4>
			{children}
		</div>
	);
}

function TooltipText({ text }: { text: string }) {
	return (
		<Tooltip title={text}>
			<div className="max-w-[150px] truncate text-slate-500 cursor-help">{text}</div>
		</Tooltip>
	);
}
