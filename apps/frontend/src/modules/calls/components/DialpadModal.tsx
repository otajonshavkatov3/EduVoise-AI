import { ClockCircleOutlined, PhoneOutlined, UserOutlined } from "@ant-design/icons";
import { Button, Modal, Tag } from "antd";
import { useDialpadModal } from "../hooks/useDialpadModal";
import { DialpadContacts } from "./DialpadModal/DialpadContacts";
import { DialpadHistory } from "./DialpadModal/DialpadHistory";
import { DialpadKeypad } from "./DialpadModal/DialpadKeypad";

interface DialpadModalProps {
	open: boolean;
	onClose: () => void;
}

export function DialpadModal({ open, onClose }: DialpadModalProps) {
	const {
		activeTab,
		setActiveTab,
		phoneNumber,
		setSearchQuery,
		calls,
		isCallsLoading,
		contacts,
		isContactsLoading,
		connectionStatus,
		isRegistered,
		isInCall,
		handleNumberClick,
		handleDelete,
		handleCall,
		quickDial,
	} = useDialpadModal(open, onClose);

	const getConnectionBadge = () => {
		if (isRegistered) {
			return (
				<Tag
					color="success"
					className="absolute top-4 right-4 rounded-full text-[9px] font-bold border-none"
				>
					Ulangan
				</Tag>
			);
		}
		if (connectionStatus === "connecting" || connectionStatus === "connected") {
			return (
				<Tag
					color="processing"
					className="absolute top-4 right-4 rounded-full text-[9px] font-bold border-none animate-pulse"
				>
					Ulanmoqda...
				</Tag>
			);
		}
		return (
			<Tag
				color="default"
				className="absolute top-4 right-4 rounded-full text-[9px] font-bold border-none"
			>
				Uzilgan
			</Tag>
		);
	};

	return (
		<Modal
			open={open}
			onCancel={onClose}
			footer={null}
			width={550}
			centered
			className="dialpad-modal-v2"
			styles={{
				body: { padding: 0, borderRadius: "32px", overflow: "hidden" },
			}}
			closable={false}
		>
			<div className="flex flex-col h-[810px] bg-white">
				<div className="flex items-center justify-between px-6 pt-6 pb-2 border-b border-slate-50">
					<div className="flex gap-1 bg-slate-100 p-1 rounded-2xl">
						<Button
							type={activeTab === "dialpad" ? "primary" : "text"}
							onClick={() => setActiveTab("dialpad")}
							className={`rounded-xl h-10 px-4 border-none shadow-none ${
								activeTab === "dialpad"
									? "bg-white text-slate-900 font-bold"
									: "text-slate-500 hover:text-slate-900"
							}`}
						>
							<PhoneOutlined /> Raqam terish
						</Button>
						<Button
							type={activeTab === "history" ? "primary" : "text"}
							onClick={() => setActiveTab("history")}
							className={`rounded-xl h-10 px-4 border-none shadow-none ${
								activeTab === "history"
									? "bg-white text-slate-900 font-bold"
									: "text-slate-500 hover:text-slate-900"
							}`}
						>
							<ClockCircleOutlined /> Tarix
						</Button>
						<Button
							type={activeTab === "contacts" ? "primary" : "text"}
							onClick={() => setActiveTab("contacts")}
							className={`rounded-xl h-10 px-4 border-none shadow-none ${
								activeTab === "contacts"
									? "bg-white text-slate-900 font-bold"
									: "text-slate-500 hover:text-slate-900"
							}`}
						>
							<UserOutlined /> Kontaktlar
						</Button>
					</div>
					<div className="flex items-center gap-2">
						{getConnectionBadge()}
						<Button
							type="text"
							onClick={onClose}
							className="text-slate-400 hover:text-slate-900 font-medium"
						>
							Yopish
						</Button>
					</div>
				</div>

				<div className="flex-1 overflow-hidden">
					{activeTab === "dialpad" && (
						<DialpadKeypad
							phoneNumber={phoneNumber}
							isRegistered={isRegistered}
							isInCall={isInCall}
							onDigit={handleNumberClick}
							onDelete={handleDelete}
							onCall={handleCall}
							quickDial={quickDial}
						/>
					)}

					{activeTab === "history" && (
						<DialpadHistory calls={calls} isLoading={isCallsLoading} onCall={handleCall} />
					)}

					{activeTab === "contacts" && (
						<DialpadContacts
							contacts={contacts}
							isLoading={isContactsLoading}
							onSearch={setSearchQuery}
							onCall={handleCall}
						/>
					)}
				</div>
			</div>
		</Modal>
	);
}
