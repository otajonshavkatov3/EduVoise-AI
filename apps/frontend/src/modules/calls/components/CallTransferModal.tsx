import { LoadingOutlined, PhoneOutlined, ShareAltOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Modal, Spin } from "antd";
import { useCallTransferModal } from "../hooks/useCallTransferModal";
import { ConsultingAlert } from "./CallTransferModal/ConsultingAlert";
import { OperatorsList } from "./CallTransferModal/OperatorsList";
import { TransferModeSelector } from "./CallTransferModal/TransferModeSelector";

interface CallTransferModalProps {
	open: boolean;
	onClose: () => void;
	onBeforeTransfer?: () => void;
}

export function CallTransferModal({ open, onClose, onBeforeTransfer }: CallTransferModalProps) {
	const {
		mode,
		setMode,
		attendedStep,
		setAttendedStep,
		searchQuery,
		setSearchQuery,
		customNumber,
		setCustomNumber,
		isTransferring,
		error,
		setError,
		consultingWith,
		setConsultingWith,
		isLoading,
		isCallEstablished,
		operators,
		handleClose,
		handleCompleteAttended,
		handleTransferTarget,
		getActionLabel,
	} = useCallTransferModal(onClose, onBeforeTransfer);

	return (
		<Modal
			title={
				<div className="flex items-center gap-3">
					<div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center">
						<ShareAltOutlined className="text-blue-500" />
					</div>
					<div>
						<div className="font-black text-slate-900 leading-none">Qo'ng'iroqni uzatish</div>
						<div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">
							SIP orqali uzatish
						</div>
					</div>
				</div>
			}
			open={open}
			onCancel={handleClose}
			footer={null}
			centered
			width={480}
			styles={{
				mask: { backdropFilter: "blur(6px)", background: "rgba(15,23,42,0.4)" },
				body: { padding: "0 24px 24px" },
				header: { padding: "20px 24px 16px", borderBottom: "1px solid #f1f5f9" },
			}}
		>
			{attendedStep === "select" && <TransferModeSelector mode={mode} onModeChange={setMode} />}

			{attendedStep === "consulting" && (
				<ConsultingAlert
					consultingWith={consultingWith}
					isTransferring={isTransferring}
					onCancel={() => {
						setAttendedStep("select");
						setConsultingWith(null);
					}}
					onComplete={handleCompleteAttended}
				/>
			)}

			{!isCallEstablished && (
				<Alert
					type="warning"
					showIcon
					message="Faol qo'ng'iroq mavjud emas"
					description="Uzatish faqat o'rnatilgan SIP qo'ng'iroqda ishlaydi."
					className="rounded-2xl mb-4 border-amber-100 bg-amber-50"
				/>
			)}

			{error && (
				<Alert
					type="error"
					showIcon
					message={error}
					closable
					onClose={() => setError(null)}
					className="rounded-2xl mb-4 border-red-100 bg-red-50"
				/>
			)}

			{attendedStep === "select" && (
				<>
					<div className="mb-4">
						<div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
							Qo'lda raqam kiritish
						</div>
						<div className="flex gap-2">
							<Input
								placeholder="Ichki raqam yoki telefon raqami"
								value={customNumber}
								onChange={(e) => setCustomNumber(e.target.value.replace(/\D/g, ""))}
								onPressEnter={() => {
									if (customNumber) {
										handleTransferTarget(customNumber, customNumber);
									}
								}}
								prefix={<PhoneOutlined className="text-slate-400" />}
								className="h-10 rounded-xl bg-slate-50 border-slate-200 focus:border-blue-400 flex-1"
								maxLength={15}
							/>
							<Button
								type="primary"
								disabled={!customNumber || isTransferring || !isCallEstablished}
								loading={isTransferring}
								onClick={() => {
									if (customNumber) {
										handleTransferTarget(customNumber, customNumber);
									}
								}}
								className="h-10 rounded-xl px-4 bg-blue-500 hover:bg-blue-600! border-none font-bold"
							>
								{getActionLabel()}
							</Button>
						</div>
					</div>

					<div>
						<div className="flex items-center justify-between mb-2">
							<div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
								Operatorlar
							</div>
							{isTransferring && <Spin indicator={<LoadingOutlined spin />} size="small" />}
						</div>
						<Input
							placeholder="Qidirish..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="h-9 rounded-xl bg-slate-50 border-slate-200 mb-3 text-sm"
							allowClear
						/>
						<OperatorsList
							operators={operators}
							isLoading={isLoading}
							isCallEstablished={isCallEstablished}
							isTransferring={isTransferring}
							actionLabel={getActionLabel()}
							onSelect={handleTransferTarget}
						/>
					</div>
				</>
			)}

			<div className="mt-4 pt-4 border-t border-slate-50">
				<Button
					onClick={handleClose}
					block
					className="h-11 rounded-2xl font-bold border-slate-100 bg-slate-50 text-slate-600 hover:bg-slate-100! hover:border-slate-200!"
				>
					Yopish
				</Button>
			</div>
		</Modal>
	);
}
