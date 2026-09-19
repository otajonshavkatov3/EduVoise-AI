import { ClockCircleOutlined, NotificationOutlined, RobotOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, InputNumber, Modal, Select } from "antd";
import { useEffect, useMemo } from "react";
import { useActiveAgentProfile, useAgentProfiles } from "@/modules/ai-agent/hooks/useAiAgent";
import { useCreateCampaign, useUpdateCampaign } from "../hooks/useCampaigns";
import type { Campaign, CampaignKind } from "../types";
import {
	CALL_TIME_OPTIONS,
	type CampaignFormValues,
	CONCURRENCY_RANGE,
	DEFAULT_FORM_VALUES,
	formatMinutes,
	MAX_ATTEMPTS_RANGE,
	NAME_MAX,
	NAME_MIN,
	PURPOSE_MAX,
	PURPOSE_MIN,
	RETRY_DELAY_RANGE,
	SCRIPT_MAX,
	toCreateBody,
	toFormValues,
	toUpdateBody,
} from "../utils/form";
import { CAMPAIGN_KIND_HINTS, CAMPAIGN_KIND_LABELS, optionsFrom } from "../utils/labels";
import { toPreviewLanguage } from "../utils/openingLine";
import { OpeningLinePreview } from "./OpeningLinePreview";

interface Props {
	open: boolean;
	/** null — yangi kampaniya; aks holda tahrirlash. */
	campaign: Campaign | null;
	onClose: () => void;
	onCreated?: (campaign: Campaign) => void;
}

const KIND_OPTIONS = optionsFrom(CAMPAIGN_KIND_LABELS);

function labelOf(text: string) {
	return <span className="font-bold text-slate-700">{text}</span>;
}

/**
 * Create and edit in one modal, because the fields are identical and the purpose
 * preview has to behave the same in both.
 *
 * A campaign is created as a DRAFT and nothing is dialled: the list is imported
 * afterwards and starting is a separate, confirmed action. That is why this form
 * has no "save and start" - the two decisions are not the same decision.
 */
export function CampaignFormModal({ open, campaign, onClose, onCreated }: Props) {
	const [form] = Form.useForm<CampaignFormValues>();
	const createCampaign = useCreateCampaign();
	const updateCampaign = useUpdateCampaign();

	const activeProfileQuery = useActiveAgentProfile();
	const profilesQuery = useAgentProfiles();

	const baseline = useMemo(
		() => (campaign === null ? DEFAULT_FORM_VALUES : toFormValues(campaign)),
		[campaign]
	);

	// The modal is kept mounted by antd, so the fields have to be reset whenever it
	// is opened for a different campaign - otherwise the previous one's purpose is
	// still sitting in the box.
	useEffect(() => {
		if (open) {
			form.setFieldsValue(baseline);
		}
	}, [open, baseline, form]);

	const purpose = Form.useWatch("purpose", form) ?? baseline.purpose;
	const kind = Form.useWatch("kind", form) ?? baseline.kind;
	const selectedProfileId = Form.useWatch("agentProfileId", form);

	const activeProfile = activeProfileQuery.data?.data;
	const profiles = profilesQuery.data?.items ?? [];
	const selectedProfile = profiles.find((item) => item.id === selectedProfileId);

	// The preview must show the profile that will actually speak. The profile list
	// carries the business name and the language but not the recording notice, so
	// when a non-active profile is pinned the notice line is left out rather than
	// guessed from a different profile's wording.
	const usesActiveProfile = selectedProfileId === undefined || selectedProfile?.isActive === true;
	const businessName = selectedProfile?.businessName ?? activeProfile?.businessName ?? "";
	const language = toPreviewLanguage(selectedProfile?.language ?? activeProfile?.language);

	const isEditing = campaign !== null;
	const isSaving = createCampaign.isPending || updateCampaign.isPending;

	const handleSubmit = async (values: CampaignFormValues) => {
		if (isEditing) {
			const patch = toUpdateBody(baseline, values);

			if (Object.keys(patch).length === 0) {
				onClose();
				return;
			}

			try {
				await updateCampaign.mutateAsync({ id: campaign.id, body: patch });
				onClose();
			} catch {
				// Sabab hook'dagi toast'da.
			}

			return;
		}

		try {
			const created = await createCampaign.mutateAsync(toCreateBody(values));
			form.resetFields();
			onClose();
			onCreated?.(created);
		} catch {
			// Sabab hook'dagi toast'da.
		}
	};

	return (
		<Modal
			title={
				<div className="flex items-center gap-2 pb-2">
					<NotificationOutlined className="text-blue-600" />
					<span className="font-extrabold tracking-tight text-slate-900 uppercase">
						{isEditing ? "Kampaniyani tahrirlash" : "Yangi chiquvchi kampaniya"}
					</span>
				</div>
			}
			open={open}
			onCancel={onClose}
			footer={null}
			width={860}
			centered
			destroyOnHidden={false}
			styles={{
				mask: { backdropFilter: "blur(4px)" },
				body: { maxHeight: "72vh", overflowY: "auto" },
			}}
		>
			<Form
				form={form}
				layout="vertical"
				onFinish={handleSubmit}
				initialValues={baseline}
				className="mt-4"
			>
				<Form.Item
					name="name"
					label={labelOf("Kampaniya nomi")}
					rules={[
						{ required: true, message: "Nom kiritilishi shart" },
						{ min: NAME_MIN, message: `Kamida ${NAME_MIN} ta belgi` },
						{ max: NAME_MAX, message: `Ko'pi bilan ${NAME_MAX} ta belgi` },
					]}
					extra="Faqat ichkarida ko'rinadi — odamga aytilmaydi."
				>
					<Input placeholder="Avgust oyi qarzdorlik eslatmasi" className="h-11 rounded-xl" />
				</Form.Item>

				<Form.Item
					name="kind"
					label={labelOf("Qo'ng'iroq turi")}
					extra={CAMPAIGN_KIND_HINTS[kind as CampaignKind]}
				>
					<Select options={KIND_OPTIONS} className="h-11" />
				</Form.Item>

				<div className="mb-4 rounded-2xl border border-blue-200 bg-blue-50/40 p-4">
					<Form.Item
						name="purpose"
						label={
							<div>
								<div className="font-black text-slate-900">
									AI nima uchun qo'ng'iroq qilayotganini nima deb aytadi
								</div>
								<div className="text-[11px] font-medium text-slate-500">
									Bu yerga yozilgan gap qo'ng'iroqning ENG BOSHIDA aytiladi. Odam bu qo'ng'iroqni
									o'zi so'ramagan — birinchi gapdan sababini bilishi kerak.
								</div>
							</div>
						}
						rules={[
							{ required: true, message: "Maqsad kiritilishi shart" },
							{ min: PURPOSE_MIN, message: `Kamida ${PURPOSE_MIN} ta belgi` },
							{ max: PURPOSE_MAX, message: `Ko'pi bilan ${PURPOSE_MAX} ta belgi` },
						]}
						className="mb-3"
					>
						<Input.TextArea
							rows={3}
							showCount
							maxLength={PURPOSE_MAX}
							placeholder="avgust oyi uchun to'lov muddati o'tib ketgani haqida eslatish"
							className="rounded-xl"
						/>
					</Form.Item>

					<OpeningLinePreview
						businessName={businessName}
						recordingNotice={activeProfile?.recordingNotice ?? null}
						language={language}
						purpose={purpose ?? ""}
						leadName="Alisher"
						noticeKnown={usesActiveProfile}
					/>
				</div>

				<Form.Item
					name="script"
					label={labelOf("Qo'shimcha ko'rsatmalar (ixtiyoriy)")}
					rules={[{ max: SCRIPT_MAX, message: `Ko'pi bilan ${SCRIPT_MAX} ta belgi` }]}
					extra="Suhbatning qolgan qismi uchun — nima deyish, narx so'ralsa nima javob berish. Bu matn OVOZ CHIQARIB O'QILMAYDI."
				>
					<Input.TextArea rows={3} maxLength={SCRIPT_MAX} className="rounded-xl" />
				</Form.Item>

				<Form.Item
					name="agentProfileId"
					label={labelOf("Qaysi AI profil gapiradi")}
					extra="Bo'sh qoldirilsa — o'sha paytda faol bo'lgan profil. Kiruvchi qo'ng'iroqlar bilan bir xil."
				>
					<Select
						allowClear
						placeholder="Faol profil"
						loading={profilesQuery.isLoading}
						options={profiles.map((profile) => ({
							value: profile.id,
							label: profile.isActive ? `${profile.businessName} (faol)` : profile.businessName,
						}))}
						className="h-11"
					/>
				</Form.Item>

				<div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
					<h4 className="mb-4 flex items-center gap-2 text-xs font-black tracking-widest text-slate-400 uppercase">
						<ClockCircleOutlined /> Qo'ng'iroq oynasi va chegaralar
					</h4>

					<div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
						<Form.Item
							name="callWindowStart"
							label={labelOf("Boshlanishi")}
							rules={[{ required: true, message: "Vaqt tanlanishi shart" }]}
						>
							<Select options={CALL_TIME_OPTIONS} showSearch className="h-11" />
						</Form.Item>
						<Form.Item
							name="callWindowEnd"
							label={labelOf("Tugashi")}
							dependencies={["callWindowStart"]}
							rules={[
								{ required: true, message: "Vaqt tanlanishi shart" },
								({ getFieldValue }) => ({
									validator(_rule, value: string) {
										// Same rule as the CHECK constraint: an overnight window would mean
										// ringing somebody in the middle of the night.
										if (!value || value > getFieldValue("callWindowStart")) {
											return Promise.resolve();
										}

										return Promise.reject(
											new Error("Tugash vaqti boshlanishidan keyin bo'lishi kerak")
										);
									},
								}),
							]}
						>
							<Select options={CALL_TIME_OPTIONS} showSearch className="h-11" />
						</Form.Item>
					</div>

					<Alert
						type="info"
						showIcon
						className="mb-4 rounded-xl"
						message={`Qo'ng'iroqlar faqat shu oraliqda ketadi, tashkilot vaqt mintaqasi bo'yicha. Ruxsat etilgan chegara: ${CALL_TIME_OPTIONS[0]?.value} – ${CALL_TIME_OPTIONS[CALL_TIME_OPTIONS.length - 1]?.value}.`}
					/>

					<div className="grid grid-cols-1 gap-x-4 md:grid-cols-3">
						<Form.Item
							name="maxAttempts"
							label={labelOf("Urinishlar soni")}
							extra="Javob bermasa nechi marta qayta terilsin"
						>
							<InputNumber
								min={MAX_ATTEMPTS_RANGE.min}
								max={MAX_ATTEMPTS_RANGE.max}
								className="h-11 w-full rounded-xl"
							/>
						</Form.Item>
						<Form.Item
							name="retryDelayMinutes"
							label={labelOf("Urinishlar orasidagi tanaffus")}
							extra={`Daqiqa (${formatMinutes(RETRY_DELAY_RANGE.min)} – ${formatMinutes(RETRY_DELAY_RANGE.max)})`}
						>
							<InputNumber
								min={RETRY_DELAY_RANGE.min}
								max={RETRY_DELAY_RANGE.max}
								step={5}
								className="h-11 w-full rounded-xl"
							/>
						</Form.Item>
						<Form.Item
							name="concurrency"
							label={labelOf("Bir vaqtda")}
							extra="Bir vaqtning o'zida nechta qo'ng'iroq"
						>
							<InputNumber
								min={CONCURRENCY_RANGE.min}
								max={CONCURRENCY_RANGE.max}
								className="h-11 w-full rounded-xl"
							/>
						</Form.Item>
					</div>
				</div>

				{isEditing && campaign.status === "running" && (
					<Alert
						type="warning"
						showIcon
						className="mb-4 rounded-xl"
						message="Kampaniya hozir ishlayapti"
						description="O'zgarishlar keyingi qo'ng'iroqlardan boshlab qo'llanadi. Hozir davom etayotgan suhbatlar eski maqsad bilan tugaydi."
					/>
				)}

				<div className="mt-4 flex gap-3 border-t border-slate-100 pt-6">
					<Button className="h-12 flex-1 rounded-xl font-bold" onClick={onClose}>
						Bekor qilish
					</Button>
					<Button
						type="primary"
						htmlType="submit"
						icon={<RobotOutlined />}
						loading={isSaving}
						className="h-12 flex-1 rounded-xl font-bold shadow-lg shadow-blue-500/20"
					>
						{isEditing ? "Saqlash" : "Qoralama sifatida yaratish"}
					</Button>
				</div>
			</Form>
		</Modal>
	);
}
