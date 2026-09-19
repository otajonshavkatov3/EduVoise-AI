import { PhoneOutlined, ShareAltOutlined, WarningOutlined } from "@ant-design/icons";
import { Alert, App, Button, Input, Modal, Select } from "antd";
import { useMemo, useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { formatPhone } from "@/shared/utils/phoneFormat";
import { useAsteriskExtensions, useTransferCall } from "../hooks/useLiveCalls";
import type { LiveCallRow, TransferCallResponse } from "../types";

interface Props {
	open: boolean;
	call: LiveCallRow | null;
	onClose: () => void;
}

const EXTENSION_PATTERN = /^\d{2,10}$/;

/** Bo'sh nishon backend'ga yuborilmaydi: u holda router o'zi operator tanlaydi. */
function validateTarget(target: string): string | null {
	if (target.length === 0) {
		return null;
	}
	if (!EXTENSION_PATTERN.test(target)) {
		return "Ichki raqam 2-10 ta raqamdan iborat bo'lishi kerak (masalan 101)";
	}
	return null;
}

function successText(extension: string | null): string {
	return extension ? `Qo'ng'iroq ${extension} raqamiga uzatildi` : "Qo'ng'iroq operatorga uzatildi";
}

function extensionOptionLabel(
	extension: string,
	displayName: string | null,
	isRegistered: boolean | null
): string {
	const name = displayName ? ` — ${displayName}` : "";
	if (isRegistered === null) {
		return `${extension}${name}`;
	}
	return `${extension}${name}${isRegistered ? " (onlayn)" : " (oflayn)"}`;
}

export function TransferCallModal({ open, call, onClose }: Props) {
	const { message } = App.useApp();
	const [extension, setExtension] = useState<string>("");
	const [manualExtension, setManualExtension] = useState<string>("");
	const [reason, setReason] = useState<string>("");
	const [formError, setFormError] = useState<string | null>(null);

	const extensionsQuery = useAsteriskExtensions(open);
	const transfer = useTransferCall();

	const options = useMemo(() => {
		const items = extensionsQuery.data?.data.items ?? [];
		return items
			.filter((item) => item.kind !== "ai" && item.isEnabled)
			.map((item) => ({
				value: item.extension,
				label: extensionOptionLabel(
					item.extension,
					item.displayName,
					item.live === null ? null : item.live.isRegistered
				),
			}));
	}, [extensionsQuery.data]);

	const resetForm = () => {
		setExtension("");
		setManualExtension("");
		setReason("");
		setFormError(null);
		transfer.reset();
	};

	const handleClose = () => {
		resetForm();
		onClose();
	};

	const handleResult = (data: TransferCallResponse["data"]) => {
		if (data.connected) {
			message.success(successText(data.extension));
			handleClose();
			return;
		}
		if (data.alreadyInProgress) {
			message.info("Uzatish allaqachon boshlangan");
			handleClose();
			return;
		}
		setFormError(data.failureReason ?? "Uzatish amalga oshmadi");
	};

	const handleSubmit = async () => {
		if (!call) {
			return;
		}

		const target = manualExtension.trim() || extension.trim();
		const validationError = validateTarget(target);
		if (validationError) {
			setFormError(validationError);
			return;
		}

		setFormError(null);

		try {
			const response = await transfer.mutateAsync({
				callId: call.callId,
				extension: target || undefined,
				reason: reason.trim() || undefined,
			});
			handleResult(response.data);
		} catch (error) {
			setFormError(getApiErrorMessage(error, "Uzatish so'rovi bajarilmadi"));
		}
	};

	return (
		<Modal
			open={open}
			onCancel={handleClose}
			footer={null}
			centered
			width={460}
			destroyOnHidden
			styles={{
				mask: { backdropFilter: "blur(6px)", background: "rgba(15,23,42,0.4)" },
				header: { padding: "20px 24px 16px", borderBottom: "1px solid #f1f5f9" },
				body: { padding: "20px 24px 24px" },
			}}
			title={
				<div className="flex items-center gap-3">
					<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-500">
						<ShareAltOutlined />
					</div>
					<div>
						<div className="font-black leading-none text-slate-900">Operatorga uzatish</div>
						<div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
							{call ? formatPhone(call.callerNumber) : "—"}
						</div>
					</div>
				</div>
			}
		>
			{extensionsQuery.isError && (
				<Alert
					type="warning"
					showIcon
					icon={<WarningOutlined />}
					className="mb-4 rounded-2xl"
					message="Ichki raqamlar ro'yxatini olib bo'lmadi"
					description="Raqamni qo'lda kiriting yoki bo'sh qoldiring — tizim o'zi operator tanlaydi."
				/>
			)}

			{extensionsQuery.data?.data.ami.connected === false && (
				<Alert
					type="info"
					showIcon
					className="mb-4 rounded-2xl"
					message="AMI ulanmagan"
					description={
						extensionsQuery.data.data.ami.error ??
						"Real vaqtdagi registratsiya holati mavjud emas, ro'yxat bazadan olindi."
					}
				/>
			)}

			<div className="space-y-4">
				<div>
					<div className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-400">
						Operator ichki raqami
					</div>
					<Select
						value={extension || undefined}
						onChange={(value: string | undefined) => {
							setExtension(value ?? "");
							setManualExtension("");
						}}
						loading={extensionsQuery.isLoading}
						allowClear
						showSearch
						filterOption={(input, option) =>
							String(option?.label ?? "")
								.toLowerCase()
								.includes(input.toLowerCase())
						}
						placeholder="Tanlash (bo'sh qoldirilsa tizim o'zi tanlaydi)"
						className="h-12 w-full custom-select"
						options={options}
						notFoundContent="Ichki raqam topilmadi"
					/>
				</div>

				<div>
					<div className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-400">
						Yoki raqamni qo'lda kiriting
					</div>
					<Input
						value={manualExtension}
						onChange={(event) => {
							setManualExtension(event.target.value.replace(/\D/g, ""));
							setExtension("");
						}}
						prefix={<PhoneOutlined className="text-slate-400" />}
						placeholder="101"
						maxLength={10}
						className="h-12 rounded-xl border-slate-200 bg-slate-50"
					/>
				</div>

				<div>
					<div className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-400">
						Sabab (ixtiyoriy)
					</div>
					<Input.TextArea
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						placeholder="Masalan: mijoz operator bilan gaplashmoqchi"
						rows={2}
						maxLength={500}
						showCount
						className="rounded-xl border-slate-200 bg-slate-50"
					/>
				</div>

				{formError && (
					<Alert
						type="error"
						showIcon
						closable
						onClose={() => setFormError(null)}
						className="rounded-2xl"
						message={formError}
					/>
				)}

				<div className="flex gap-3 pt-2">
					<Button
						block
						onClick={handleClose}
						className="h-11 rounded-2xl border-slate-100 bg-slate-50 font-bold text-slate-600"
					>
						Bekor qilish
					</Button>
					<Button
						block
						type="primary"
						loading={transfer.isPending}
						onClick={handleSubmit}
						disabled={!call}
						className="h-11 rounded-2xl font-bold"
					>
						Uzatish
					</Button>
				</div>
			</div>
		</Modal>
	);
}
