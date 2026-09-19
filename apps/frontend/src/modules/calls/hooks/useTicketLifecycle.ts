import { useCallback, useEffect, useRef } from "react";
import type { TicketCreateHandle } from "@/modules/tickets/components/TicketCreateModal";
import type { TicketEditHandle } from "@/modules/tickets/components/TicketEditModal";
import type { IncomingCall } from "../store/callPop.store";
import { isEnded } from "../utils/callStatus";

interface UseTicketLifecycleOptions {
	call: IncomingCall | null;
	visible: boolean;
	activeCallStatus?: string;
	isLoadingContact: boolean;
	isLoadingTickets: boolean;
	existingTicket?: { id: string; createdAt: string } | null;
	onOpenCreate: () => void;
	onCloseCreate: () => void;
	onOpenEdit: () => void;
	onCloseEdit: () => void;
	isCreateOpen: boolean;
	isEditOpen: boolean;
}

/**
 * Ticket lifecycle:
 * - Automatically opens ticket modal when call is answered
 * - Auto-saves and closes when call ends
 *
 * Panelni yopish bu hook'ning ishi EMAS: avval u qo'ng'iroq tugagach 300 ms
 * ichida `dismissCall()` chaqirardi, ya'ni "qo'ng'iroq tugallandi" holatini
 * ko'rishning imkoni yo'q edi. Yopilishni `useEndedAutoDismiss` yuritadi.
 */
export function useTicketLifecycle({
	call,
	visible,
	activeCallStatus,
	isLoadingContact,
	isLoadingTickets,
	existingTicket,
	onOpenCreate,
	onCloseCreate,
	onOpenEdit,
	onCloseEdit,
	isCreateOpen,
	isEditOpen,
}: UseTicketLifecycleOptions) {
	const hasAutoOpenedRef = useRef(false);
	const ticketCreateRef = useRef<TicketCreateHandle>(null);
	const ticketEditRef = useRef<TicketEditHandle>(null);

	const handleTicketAction = useCallback(() => {
		const callSessionStart = new Date(call?.startedAt || Date.now()).getTime();
		const isTransferTicket =
			existingTicket && new Date(existingTicket.createdAt).getTime() > callSessionStart - 5000;

		if (isTransferTicket) {
			onOpenEdit();
		} else {
			onOpenCreate();
		}
	}, [existingTicket, call?.startedAt, onOpenCreate, onOpenEdit]);

	// Auto-open ticket modal on answer
	useEffect(() => {
		const isAnswered = activeCallStatus === "established" || call?.status === "active";

		if (
			visible &&
			isAnswered &&
			!isLoadingContact &&
			!isLoadingTickets &&
			!hasAutoOpenedRef.current
		) {
			hasAutoOpenedRef.current = true;
			setTimeout(() => handleTicketAction(), 300);
		}
	}, [
		visible,
		activeCallStatus,
		call?.status,
		isLoadingContact,
		isLoadingTickets,
		handleTicketAction,
	]);

	// Auto-save and reset on call end
	useEffect(() => {
		if (!isEnded(call?.status ?? "")) {
			return;
		}

		if (isCreateOpen) {
			ticketCreateRef.current?.submit();
			onCloseCreate();
		}
		if (isEditOpen) {
			ticketEditRef.current?.submit();
			onCloseEdit();
		}
		hasAutoOpenedRef.current = false;
	}, [call?.status, isCreateOpen, isEditOpen, onCloseCreate, onCloseEdit]);

	return {
		ticketCreateRef,
		ticketEditRef,
		hasAutoOpenedRef,
		handleTicketAction,
	};
}
