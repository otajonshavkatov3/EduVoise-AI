import { CloseOutlined } from "@ant-design/icons";
import { Button, Card } from "antd";
import { useEffect, useState } from "react";
import { useContacts } from "@/modules/contacts/hooks/useContacts";
import {
	type TicketCreateHandle,
	TicketCreateModal,
} from "@/modules/tickets/components/TicketCreateModal";
import {
	type TicketEditHandle,
	TicketEditModal,
} from "@/modules/tickets/components/TicketEditModal";
import { useTickets } from "@/modules/tickets/hooks/useTickets";
import { normalizePhone } from "@/shared/utils/phoneFormat";
import { useCalls } from "../hooks/useCalls";
import { useCallTimer } from "../hooks/useCallTimer";
import { useEndedAutoDismiss } from "../hooks/useEndedAutoDismiss";
import { useFloatingWindow } from "../hooks/useFloatingWindow";
import { useTicketLifecycle } from "../hooks/useTicketLifecycle";
import { useLiveCallsStore } from "../live/store/liveCalls.store";
import { useSipPhoneContext } from "../providers/SipPhoneProvider";
import { type IncomingCallContact, useCallPopStore } from "../store/callPop.store";
import { useSipStore } from "../store/sip.store";
import { type CallPhase, resolveCallPresentation } from "../utils/callStatus";
import { formatTime } from "../utils/formatTime";
import { CallActions } from "./CallPopModal/CallActions";
import { CallerInfo } from "./CallPopModal/CallerInfo";
import { CallHistoryList } from "./CallPopModal/CallHistoryList";
import { CallKeypad } from "./CallPopModal/CallKeypad";
import { CallPopTranscript } from "./CallPopModal/CallPopTranscript";
import { DurationCard } from "./CallPopModal/DurationCard";
import { ResizeHandles } from "./CallPopModal/ResizeHandles";
import { CallTransferModal } from "./CallTransferModal";
import { ContactNoteModal } from "./ContactNoteModal";

export function CallPopModal() {
	const { call, visible, dismissCall, updateCall } = useCallPopStore();
	const { networkQuality } = useSipStore();
	const { activeCall, sendDTMF } = useSipPhoneContext();

	// ─── Floating Window (drag + resize) ───
	const { position, size, isDragging, modalRef, handleMouseDown, handleResizeMouseDown } =
		useFloatingWindow();

	// ─── Call Timer ───
	const timerDuration = useCallTimer(
		visible,
		call?.status,
		activeCall?.status,
		activeCall?.startTime
	);

	// ─── Ko'rinish holati (jiringlash / suhbat / tugagan) ───
	const { ended, phase, displayStatus, duration } = resolveCallPresentation(
		call?.status,
		activeCall?.status,
		timerDuration,
		call?.durationSeconds
	);
	// ─── Modal State ───
	const [isTicketCreateModalOpen, setIsTicketCreateModalOpen] = useState(false);
	const [isTicketEditModalOpen, setIsTicketEditModalOpen] = useState(false);
	const [isNoteModalOpen, setIsNoteModalOpen] = useState(false);
	const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);

	// Chipta/eslatma/transfer oynalari SHU panelning bolalari, ya'ni panel
	// yopilsa ular ham yo'q bo'ladi. Qo'ng'iroqdan keyingi yozuvni aynan shu
	// sekundlarda kiritiladi, shuning uchun oyna ochiq bo'lsa sanoq to'xtaydi —
	// aks holda yarim yozilgan forma saqlanmasdan yo'qolardi.
	const wrapUpOpen =
		isTicketCreateModalOpen || isTicketEditModalOpen || isNoteModalOpen || isTransferModalOpen;
	const dismissInSeconds = useEndedAutoDismiss(ended, dismissCall, wrapUpOpen);

	// ─── Contact Lookup ───
	const searchNumber = call?.direction === "inbound" ? call?.callerNumber : call?.calleeExtension;
	const normalizedNumber = searchNumber ? normalizePhone(searchNumber) : undefined;
	const contactAlreadySet = !!call?.contact?.id;

	// ─── Iliq uzatish: AI transkriptini bog'lash ───
	// Backend qo'ng'iroq id'si `call.id` ga (incoming_call / live_call_started WS
	// ramkalari orqali) yoziladi; bo'lmasa jonli doskadan callerNumber bo'yicha
	// hali tugamagan mos qatordan olinadi. String qaytadi — zustand uni qiymat
	// bo'yicha solishtiradi, ortiqcha render bo'lmaydi.
	const liveCallId = useLiveCallsStore((state) => {
		if (call?.id) {
			return call.id;
		}
		if (!normalizedNumber) {
			return null;
		}
		const match = Object.values(state.calls).find(
			(row) => row.endedAtMs === null && normalizePhone(row.callerNumber) === normalizedNumber
		);
		return match?.callId ?? null;
	});

	const { data: contactsData, isLoading: isLoadingContact } = useContacts(
		{ phoneNumber: normalizedNumber, limit: 1 },
		!!normalizedNumber && visible && !contactAlreadySet
	);

	useEffect(() => {
		if (!(visible && normalizedNumber) || contactAlreadySet) {
			return;
		}
		if (isLoadingContact || !contactsData) {
			return;
		}

		const foundContact = contactsData.data.items[0];
		if (foundContact) {
			const contactForStore: IncomingCallContact = {
				id: foundContact.id,
				firstName: foundContact.firstName,
				lastName: foundContact.lastName,
				contactName:
					foundContact.firstName || foundContact.lastName
						? `${foundContact.firstName || ""} ${foundContact.lastName || ""}`.trim()
						: null,
				address: foundContact.address,
				notes: foundContact.notes,
			};
			updateCall({ contact: contactForStore });
		}
	}, [isLoadingContact, contactsData, normalizedNumber, visible, contactAlreadySet, updateCall]);

	// ─── Call History ───
	// `phoneNumber` — serverda haqiqatan qo'llanadigan filtr. Avval bu yerda `q`
	// yuborilardi, lekin `GET /calls` uni bilmaydi va e'tiborsiz qoldirardi:
	// natijada "Oxirgi qo'ng'iroqlar" ro'yxatida shu abonentning emas, umumiy
	// oxirgi 3 qo'ng'iroq ko'rinardi. Moslik topilmasa ro'yxat bo'sh qoladi —
	// bu boshqa odamning tarixini ko'rsatishdan yaxshiroq.
	const { data: historyData } = useCalls(
		{ phoneNumber: normalizedNumber, limit: 3 },
		!!normalizedNumber && visible
	);
	const history = historyData?.data.items || [];

	// ─── Ticket Intelligence ───
	const { data: ticketsData, isLoading: isLoadingTickets } = useTickets(
		{ contactId: call?.contact?.id, status: "new" },
		!!call?.contact?.id && visible
	);
	const existingTicket = ticketsData?.data.items.find(
		(t) => t.status !== "resolved" && t.status !== "closed"
	);

	// ─── Ticket Lifecycle (auto-open, auto-save) ───
	const { ticketCreateRef, ticketEditRef, handleTicketAction } = useTicketLifecycle({
		call,
		visible,
		activeCallStatus: activeCall?.status,
		isLoadingContact,
		isLoadingTickets,
		existingTicket,
		onOpenCreate: () => setIsTicketCreateModalOpen(true),
		onCloseCreate: () => setIsTicketCreateModalOpen(false),
		onOpenEdit: () => setIsTicketEditModalOpen(true),
		onCloseEdit: () => setIsTicketEditModalOpen(false),
		isCreateOpen: isTicketCreateModalOpen,
		isEditOpen: isTicketEditModalOpen,
	});

	// ─── Render ───
	if (!(visible && call)) {
		return null;
	}

	return (
		<div
			ref={modalRef}
			role="dialog"
			aria-label="Muloqot paneli"
			style={{
				position: "fixed",
				left: position.x,
				top: position.y,
				width: size.width,
				height: size.height,
				zIndex: 3000,
			}}
			className={`animate-in fade-in transition-shadow duration-300 ${isDragging ? "shadow-2xl scale-[1.01]" : ""}`}
			onMouseDown={handleMouseDown}
		>
			<Card
				title={<PanelTitle phase={phase} />}
				extra={<DismissButton onClick={dismissCall} />}
				className="h-full border-none shadow-[0_45px_100px_-20px_rgba(0,0,0,0.3)] rounded-[32px] overflow-hidden flex flex-col bg-white/95 backdrop-blur-3xl"
				styles={{
					body: {
						padding: "16px",
						flex: 1,
						overflowY: "auto",
						display: "flex",
						flexDirection: "column",
						background: "linear-gradient(135deg, #ffffff 0%, #f9fafb 100%)",
					},
					header: {
						borderBottom: "1px solid #f1f5f9",
						padding: "12px 16px",
						background: "#fff",
					},
				}}
			>
				<DurationCard
					duration={duration}
					status={displayStatus}
					direction={activeCall?.direction || call.direction}
					formatTime={formatTime}
					networkQuality={networkQuality}
					endReason={call.endReason}
					endedAt={call.endedAt}
					dismissInSeconds={dismissInSeconds}
				/>

				<div className="flex-1 space-y-4 overflow-y-auto pr-1 custom-scrollbar">
					<CallerInfo
						call={call}
						searchNumber={searchNumber || "Yashirin raqam"}
						isLoadingContact={isLoadingContact && !contactAlreadySet}
					/>

					{/* Iliq uzatish: AI bilan bo'lgan suhbat + uzatish sababi. Bog'liq
						    backend qo'ng'irog'i topilmasa hech nima ko'rsatmaydi. */}
						<CallPopTranscript callId={liveCallId} />

						{activeCall?.status === "established" && <CallKeypad onDigit={(d) => sendDTMF(d)} />}

					<CallHistoryList history={history} />
				</div>

				<div className="mt-auto">
					<CallActions
						status={call.status}
						hasExistingTicket={!!existingTicket}
						isLoadingTickets={isLoadingTickets}
						onTicket={handleTicketAction}
						onNote={() => setIsNoteModalOpen(true)}
						onTransfer={() => setIsTransferModalOpen(true)}
						onDismiss={dismissCall}
					/>
				</div>

				<ResizeHandles onResize={handleResizeMouseDown} />
			</Card>

			{/* Modals */}
			<TicketCreateModal
				ref={ticketCreateRef as React.RefObject<TicketCreateHandle>}
				open={isTicketCreateModalOpen}
				onCancel={() => setIsTicketCreateModalOpen(false)}
				initialContactId={call.contact?.id}
				initialPhoneNumber={call.contact ? undefined : normalizedNumber}
				call={call}
			/>

			<TicketEditModal
				ref={ticketEditRef as React.RefObject<TicketEditHandle>}
				open={isTicketEditModalOpen}
				ticket={existingTicket || null}
				onCancel={() => setIsTicketEditModalOpen(false)}
			/>

			{call.contact?.id && (
				<ContactNoteModal
					open={isNoteModalOpen}
					onClose={() => setIsNoteModalOpen(false)}
					contactId={call.contact.id}
					initialNote={call.contact.notes}
				/>
			)}

			<CallTransferModal
				open={isTransferModalOpen}
				onClose={() => setIsTransferModalOpen(false)}
				onBeforeTransfer={() => {
					if (isTicketCreateModalOpen) {
						ticketCreateRef.current?.submit();
					}
					if (isTicketEditModalOpen) {
						ticketEditRef.current?.submit();
					}
				}}
			/>
		</div>
	);
}

// ─── Small inline components ──────────────────────────────────────

/**
 * Sarlavhadagi nuqta. Tugagan qo'ng'iroqda animatsiya yo'q va rang jonli
 * qo'ng'iroqlar doskasidagi tugagan qator bilan bir xil (slate) — avval u
 * kiruvchi qo'ng'iroq kabi ko'k rangda sakrab turardi.
 */
function PanelTitle({ phase }: { phase: CallPhase }) {
	const dotClass =
		phase === "ended"
			? "bg-slate-300 border-2 border-slate-100"
			: phase === "active"
				? "bg-emerald-500 animate-pulse border-2 border-emerald-200"
				: "bg-blue-500 animate-bounce border-2 border-blue-200";

	return (
		<div className="flex items-center gap-3 cursor-move select-none">
			<div className={`w-3 h-3 rounded-full shadow-lg ${dotClass}`} />
			<span className="font-black text-slate-800 text-base tracking-tight uppercase">
				Muloqot Paneli
			</span>
		</div>
	);
}

function DismissButton({ onClick }: { onClick: () => void }) {
	return (
		<Button
			type="text"
			shape="circle"
			icon={<CloseOutlined className="text-lg" />}
			onClick={onClick}
			className="text-slate-400 hover:bg-red-50 hover:text-red-500 transition-all scale-100 hover:scale-110"
		/>
	);
}
