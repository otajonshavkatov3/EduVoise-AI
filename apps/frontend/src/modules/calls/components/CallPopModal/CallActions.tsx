import {
	AudioMutedOutlined,
	AudioOutlined,
	CloseOutlined,
	EditOutlined,
	PauseCircleOutlined,
	PhoneOutlined,
	PlayCircleOutlined,
	PlusOutlined,
	ShareAltOutlined,
} from "@ant-design/icons";
import { Button, Typography } from "antd";
import { useSipPhoneContext } from "../../providers/SipPhoneProvider";
import type { IncomingCall } from "../../store/callPop.store";
import { isEnded } from "../../utils/callStatus";

const { Text } = Typography;

interface CallActionsProps {
	status: IncomingCall["status"];
	hasExistingTicket: boolean;
	isLoadingTickets: boolean;
	onTicket: () => void;
	onNote: () => void;
	onTransfer: () => void;
	onDismiss: () => void;
}

export function CallActions({
	status,
	hasExistingTicket,
	isLoadingTickets,
	onTicket,
	onNote,
	onTransfer,
	onDismiss,
}: CallActionsProps) {
	const { activeCall, answerCall, hangup, rejectCall, toggleMute, toggleHold } =
		useSipPhoneContext();

	const ended = isEnded(status);
	const isActive = !ended && (status === "ringing" || status === "active");
	const isSipRinging =
		!ended && activeCall?.status === "ringing" && activeCall.direction === "inbound";
	const isSipEstablished = !ended && activeCall?.status === "established";

	return (
		<div className="pt-6 shrink-0 bg-white/50 backdrop-blur-sm rounded-t-[32px] border-t border-slate-100 p-2">
			{/* CRM Actions */}
			<CrmButtons
				hasExistingTicket={hasExistingTicket}
				isLoadingTickets={isLoadingTickets}
				onTicket={onTicket}
				onNote={onNote}
			/>

			<Button
				icon={<ShareAltOutlined className="text-lg" />}
				onClick={onTransfer}
				disabled={!isSipEstablished}
				className="w-full h-11 rounded-xl font-black border-none bg-indigo-50 text-indigo-700 mb-4 hover:bg-indigo-100! shadow-sm transition-all scale-100 hover:scale-[1.02] disabled:opacity-30 disabled:grayscale"
			>
				Yo'naltirish
			</Button>

			{/* In-Call Controls */}
			{isSipEstablished && (
				<InCallControls
					isMuted={activeCall.isMuted}
					isOnHold={activeCall.isOnHold}
					onToggleMute={toggleMute}
					onToggleHold={toggleHold}
				/>
			)}

			{/* Primary Call Actions */}
			{isSipRinging ? (
				<RingingActions onReject={rejectCall} onAnswer={answerCall} />
			) : (
				<EndCallButton
					ended={ended}
					isActive={isActive}
					isSipEstablished={isSipEstablished}
					activeCall={activeCall}
					isSipRinging={isSipRinging}
					onHangup={hangup}
					onDismiss={onDismiss}
				/>
			)}
		</div>
	);
}

// ─── Sub-components ────────────────────────────────────────────────

function CrmButtons({
	hasExistingTicket,
	isLoadingTickets,
	onTicket,
	onNote,
}: {
	hasExistingTicket: boolean;
	isLoadingTickets: boolean;
	onTicket: () => void;
	onNote: () => void;
}) {
	return (
		<div className="grid grid-cols-2 gap-4 mb-4">
			<Button
				icon={
					hasExistingTicket ? (
						<EditOutlined className="text-lg" />
					) : (
						<PlusOutlined className="text-lg" />
					)
				}
				onClick={onTicket}
				loading={isLoadingTickets}
				className={`h-11 rounded-xl font-black border-none shadow-sm transition-all ${
					hasExistingTicket
						? "bg-amber-100 text-amber-700 hover:bg-amber-200! scale-100 hover:scale-[1.03]"
						: "bg-blue-50 text-blue-600 hover:bg-blue-100! scale-100 hover:scale-[1.03]"
				}`}
			>
				{hasExistingTicket ? "Tahrirlash" : "Murojaat"}
			</Button>
			<Button
				icon={<PlusOutlined className="text-lg" />}
				onClick={onNote}
				className="h-11 rounded-xl font-black border-none bg-slate-900 text-white hover:bg-slate-800! shadow-lg shadow-slate-900/20 transition-all scale-100 hover:scale-[1.03]"
			>
				Eslatma
			</Button>
		</div>
	);
}

function InCallControls({
	isMuted,
	isOnHold,
	onToggleMute,
	onToggleHold,
}: {
	isMuted: boolean;
	isOnHold: boolean;
	onToggleMute: () => void;
	onToggleHold: () => void;
}) {
	return (
		<div className="flex justify-center gap-4 mb-4 mt-1">
			<div className="flex flex-col items-center gap-1.5">
				<Button
					type={isMuted ? "primary" : "default"}
					shape="circle"
					size="large"
					icon={isMuted ? <AudioMutedOutlined /> : <AudioOutlined />}
					onClick={onToggleMute}
					className={`w-12 h-12 flex items-center justify-center border-none shadow-lg transition-all hover:scale-110 active:scale-95 ${
						isMuted
							? "bg-red-500 text-white shadow-red-500/30"
							: "bg-slate-100 text-slate-600 hover:bg-slate-200!"
					}`}
				/>
				<Text className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">
					{isMuted ? "Mikrofon o'chiq" : "Mikrofon"}
				</Text>
			</div>

			<div className="flex flex-col items-center gap-1.5">
				<Button
					type={isOnHold ? "primary" : "default"}
					shape="circle"
					size="large"
					icon={isOnHold ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
					onClick={onToggleHold}
					className={`w-12 h-12 flex items-center justify-center border-none shadow-lg transition-all hover:scale-110 active:scale-95 ${
						isOnHold
							? "bg-amber-500 text-white shadow-amber-500/30"
							: "bg-slate-100 text-slate-600 hover:bg-slate-200!"
					}`}
				/>
				<Text className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">
					{isOnHold ? "Davom ettirish" : "Kutish"}
				</Text>
			</div>
		</div>
	);
}

function RingingActions({ onReject, onAnswer }: { onReject: () => void; onAnswer: () => void }) {
	return (
		<div className="flex gap-4 mb-2">
			<Button
				type="primary"
				danger
				size="large"
				icon={<PhoneOutlined className="rotate-135 text-lg" />}
				// Panel bu yerda YOPILMAYDI: yakuniy holatni `SessionState.Terminated`
				// yozadi va operator "Rad etildi" holatini ko'rishi kerak. Avval
				// darhol yopilib, chipta shakli ham saqlanmay yo'qolib ketardi.
				onClick={onReject}
				className="flex-1 h-16 rounded-2xl font-black border-none shadow-xl shadow-red-500/30 text-base transition-all hover:scale-[1.05] active:scale-95"
			>
				RAD ETISH
			</Button>
			<Button
				type="primary"
				size="large"
				icon={<PhoneOutlined className="text-lg" />}
				onClick={onAnswer}
				className="flex-1 h-16 rounded-2xl font-black border-none bg-emerald-500 hover:bg-emerald-600! shadow-xl shadow-emerald-500/30 text-base transition-all hover:scale-[1.05] active:scale-95"
			>
				JAVOB
			</Button>
		</div>
	);
}

function EndCallButton({
	ended,
	isActive,
	isSipEstablished,
	activeCall,
	isSipRinging,
	onHangup,
	onDismiss,
}: {
	ended: boolean;
	isActive: boolean;
	isSipEstablished: boolean;
	// biome-ignore lint/suspicious/noExplicitAny: SIP active call type is complex
	activeCall: any;
	isSipRinging: boolean;
	onHangup: () => void;
	onDismiss: () => void;
}) {
	const isLive = isActive || isSipEstablished;

	return (
		<Button
			type="primary"
			danger={isLive}
			icon={
				isLive ? (
					<PhoneOutlined className="rotate-135 text-lg" />
				) : (
					<CloseOutlined className="text-lg" />
				)
			}
			size="large"
			onClick={() => {
				// Tugagan qo'ng'iroqda tugma faqat panelni yopadi. Aks holda uzish
				// so'raladi va panel O'ZI YOPILMAYDI: yakuniy holatni
				// `SessionState.Terminated` yozadi, keyin panel sanoq bilan yopiladi.
				if (ended) {
					onDismiss();
					return;
				}
				if (isSipEstablished || isSipRinging || activeCall) {
					onHangup();
					return;
				}
				// SIP sessiyasi yo'q (panelni server hodisasi ochgan) — uzadigan narsa
				// bo'lmasa panel qo'lda yopiladi.
				onDismiss();
			}}
			className={`w-full h-16 rounded-2xl font-black border-none shadow-xl transition-all hover:scale-[1.02] active:scale-95 ${
				isLive
					? "bg-red-500 hover:bg-red-600! shadow-red-500/30"
					: "bg-slate-900 hover:bg-slate-800! shadow-slate-900/20"
			}`}
		>
			{isLive ? "YAKUNLASH" : "PANELNI YOPISH"}
		</Button>
	);
}
