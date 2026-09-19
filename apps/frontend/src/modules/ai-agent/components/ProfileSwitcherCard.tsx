import { CheckCircleOutlined, PlusOutlined, ProfileOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Empty, Form, Input, Modal, Popconfirm, Table, Tag } from "antd";
import { useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import {
	useActivateAgentProfile,
	useAgentProfiles,
	useCreateAgentProfile,
	useDeleteAgentProfile,
} from "../hooks/useAiAgent";
import type { AgentProfileSummary } from "../types";
import { languageLabel, unknownPolicyLabel } from "../utils/labels";

interface Props {
	canEdit: boolean;
}

interface CreateFormValues {
	businessName: string;
	industry?: string;
}

/**
 * Profillar ro'yxati.
 *
 * Bittasi faol bo'ladi — qo'ng'iroqlarga aynan u javob beradi. Qolganlari
 * qoralama: yangi personani jonli liniyaga tegmasdan tayyorlab qo'yish uchun.
 */
export function ProfileSwitcherCard({ canEdit }: Props) {
	const [form] = Form.useForm<CreateFormValues>();
	const [isCreateOpen, setIsCreateOpen] = useState(false);

	const profilesQuery = useAgentProfiles();
	const createProfile = useCreateAgentProfile();
	const activateProfile = useActivateAgentProfile();
	const deleteProfile = useDeleteAgentProfile();

	const profiles = profilesQuery.data?.items ?? [];

	const handleCreate = async (values: CreateFormValues) => {
		try {
			await createProfile.mutateAsync({
				businessName: values.businessName.trim(),
				industry: values.industry?.trim() ? values.industry.trim() : undefined,
			});
			form.resetFields();
			setIsCreateOpen(false);
		} catch {
			// Xato hook ichida xabar qilinadi
		}
	};

	const columns = [
		{
			title: "Biznes",
			key: "businessName",
			render: (_: unknown, record: AgentProfileSummary) => (
				<div className="flex flex-col">
					<span className="text-sm font-bold text-slate-900">{record.businessName}</span>
					<span className="text-[11px] font-medium text-slate-500">
						{record.industry?.trim() ? record.industry : "Yo'nalish ko'rsatilmagan"}
					</span>
				</div>
			),
		},
		{
			title: "Ovoz va til",
			key: "voice",
			render: (_: unknown, record: AgentProfileSummary) => (
				<div className="flex flex-col">
					<span className="text-xs font-bold text-slate-700">{record.voice ?? "—"}</span>
					<span className="text-[11px] text-slate-400">
						{record.language ? languageLabel(record.language) : "—"}
					</span>
				</div>
			),
		},
		{
			title: "Javob topilmasa",
			key: "unknownPolicy",
			render: (_: unknown, record: AgentProfileSummary) => (
				<span className="text-xs font-medium text-slate-600">
					{unknownPolicyLabel(record.unknownPolicy)}
				</span>
			),
		},
		{
			title: "Holat",
			key: "isActive",
			render: (_: unknown, record: AgentProfileSummary) =>
				record.isActive ? (
					<Tag
						color="green"
						icon={<CheckCircleOutlined />}
						className="m-0 rounded-lg border-none text-[10px] font-bold"
					>
						Qo'ng'iroqlarga javob beradi
					</Tag>
				) : (
					<Tag color="default" className="m-0 rounded-lg border-none text-[10px] font-bold">
						Qoralama
					</Tag>
				),
		},
		{
			title: "Amallar",
			key: "actions",
			render: (_: unknown, record: AgentProfileSummary) => {
				if (!canEdit) {
					return <span className="text-xs italic text-slate-400">—</span>;
				}

				return (
					<div className="flex flex-wrap gap-2">
						{!record.isActive && (
							<Popconfirm
								title="Shu profilni faollashtirish?"
								description="Keyingi qo'ng'iroqdan boshlab AI shu profil bilan javob beradi."
								okText="Faollashtirish"
								cancelText="Bekor"
								onConfirm={() => activateProfile.mutate(record.id)}
							>
								<Button size="small" type="primary" className="rounded-xl font-bold">
									Faollashtirish
								</Button>
							</Popconfirm>
						)}
						{!record.isActive && (
							<Popconfirm
								title="Profil o'chirilsinmi?"
								description="Profil bilan birga uning bilim bazasi yozuvlari ham o'chadi."
								okText="O'chirish"
								cancelText="Bekor"
								okButtonProps={{ danger: true }}
								onConfirm={() => deleteProfile.mutate(record.id)}
							>
								<Button size="small" danger className="rounded-xl font-bold">
									O'chirish
								</Button>
							</Popconfirm>
						)}
						{record.isActive && <span className="text-xs italic text-slate-400">Faol profil</span>}
					</div>
				);
			},
		},
	];

	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<div className="flex items-center gap-3">
					<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
						<ProfileOutlined />
					</div>
					<div>
						<div className="mb-1 text-sm leading-none font-black text-slate-900">Profillar</div>
						<div className="text-[9px] leading-none font-bold tracking-widest text-slate-400 uppercase">
							Bir vaqtda faqat bittasi qo'ng'iroqlarga javob beradi
						</div>
					</div>
				</div>
			}
			extra={
				canEdit ? (
					<Button
						icon={<PlusOutlined />}
						onClick={() => setIsCreateOpen(true)}
						className="h-10 rounded-xl px-4 font-bold"
					>
						Yangi profil
					</Button>
				) : null
			}
		>
			{profilesQuery.isError && (
				<Alert
					type="error"
					showIcon
					className="mb-4 rounded-xl border-rose-200 bg-rose-50"
					title={
						<span className="font-bold text-rose-600">
							{getApiErrorMessage(profilesQuery.error, "Profillarni yuklab bo'lmadi")}
						</span>
					}
				/>
			)}

			<Table
				columns={columns}
				dataSource={profiles}
				loading={profilesQuery.isLoading}
				rowKey="id"
				size="small"
				pagination={false}
				scroll={{ x: 720 }}
				rowClassName={(record) => (record.isActive ? "bg-emerald-50/50" : "")}
				locale={{
					emptyText: (
						<Empty
							className="py-8"
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description="Profil yaratilmagan"
						/>
					),
				}}
			/>

			<Modal
				open={isCreateOpen}
				title="Yangi biznes profili"
				onCancel={() => setIsCreateOpen(false)}
				onOk={() => form.submit()}
				okText="Yaratish"
				cancelText="Bekor qilish"
				confirmLoading={createProfile.isPending}
				destroyOnHidden
				centered
			>
				<Alert
					type="info"
					showIcon
					className="mb-4 rounded-xl border-blue-100 bg-blue-50"
					title={<span className="font-bold text-blue-600">Qoralama sifatida yaratiladi</span>}
					description={
						<span className="text-slate-600">
							Faollashtirmaguningizcha jonli qo'ng'iroqlarga ta'sir qilmaydi.
						</span>
					}
				/>

				<Form form={form} layout="vertical" onFinish={handleCreate} requiredMark={false}>
					<Form.Item
						name="businessName"
						label={
							<span className="text-[11px] font-black tracking-wider text-slate-800 uppercase">
								Biznes nomi
							</span>
						}
						rules={[{ required: true, message: "Biznes nomi kiritilishi shart" }]}
					>
						<Input
							maxLength={150}
							placeholder="Masalan: Oq Tish stomatologiyasi"
							className="h-12 rounded-xl border-slate-200 bg-slate-50"
						/>
					</Form.Item>

					<Form.Item
						name="industry"
						label={
							<span className="text-[11px] font-black tracking-wider text-slate-800 uppercase">
								Yo'nalish
							</span>
						}
					>
						<Input
							maxLength={100}
							placeholder="Masalan: stomatologiya klinikasi"
							className="h-12 rounded-xl border-slate-200 bg-slate-50"
						/>
					</Form.Item>
				</Form>
			</Modal>
		</Card>
	);
}
