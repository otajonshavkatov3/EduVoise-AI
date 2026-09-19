import { useCallback, useEffect, useState } from "react";
import { useCalls } from "@/modules/calls/hooks/useCalls";
import { useContacts } from "@/modules/contacts/hooks/useContacts";
import { useSipPhoneContext } from "../providers/SipPhoneProvider";
import { useCallPopStore } from "../store/callPop.store";
import { isEnded } from "../utils/callStatus";

export type DialpadTab = "dialpad" | "history" | "contacts";

export interface QuickDialEntry {
	number: string;
	label: string;
}

/**
 * Internal destinations worth one tap from the dashboard. These mirror
 * asterisk/etc/extensions.conf.template - keep the two in sync when the dialplan
 * changes. The dialled digits are unchanged by tenancy: they are matched inside the
 * caller's own tenant context, so 101 still means "my own 101".
 */
const INTERNAL_QUICK_DIAL: readonly QuickDialEntry[] = [
	{ number: "900", label: "AI agent" },
	{ number: "600", label: "Aks-sado testi" },
	{ number: "601", label: "Ovoz testi" },
	{ number: "101", label: "Operator 101" },
];

export function useDialpadModal(open: boolean, onClose: () => void) {
	const [activeTab, setActiveTab] = useState<DialpadTab>("dialpad");
	// Starts EMPTY, not "998".
	//
	// The old seed made internal extensions impossible to dial: typing 900 produced
	// "998900", which matches no extension in the dialplan, and handleDelete reset
	// straight back to "998" so it could never be cleared. Since the AI agent lives
	// on extension 900 (and the test extensions on 600/601/602), the pad has to be
	// able to send a bare 3-digit number.
	const [phoneNumber, setPhoneNumber] = useState("");
	const [searchQuery, setSearchQuery] = useState("");

	const { activeCall, connectionStatus, isRegistered, makeCall } = useSipPhoneContext();

	const { data: callsData, isLoading: isCallsLoading } = useCalls({ limit: 20 });
	const { data: contactsData, isLoading: isContactsLoading } = useContacts({
		q: searchQuery,
		limit: 50,
	});

	const calls = callsData?.data.items || [];
	const contacts = contactsData?.data.items || [];

	// Tugagan qo'ng'iroq paneli bir necha sekund ko'rinib turadi va u
	// klaviaturani yopib qo'ymasligi kerak — aks holda qo'ng'iroqdan keyin
	// darhol qayta terish mumkin bo'lmaydi.
	const popCall = useCallPopStore((s) => s.call);
	const isPopVisible = useCallPopStore((s) => s.visible);
	const hasLiveCall = isPopVisible && popCall !== null && !isEnded(popCall.status);

	useEffect(() => {
		if (hasLiveCall && open) {
			onClose();
		}
	}, [hasLiveCall, open, onClose]);

	const isInCall = !!(
		activeCall &&
		activeCall.status !== "terminated" &&
		activeCall.status !== "idle"
	);

	const handleNumberClick = useCallback((num: string) => {
		setPhoneNumber((prev) => {
			const digits = prev.replace(/\D/g, "");
			if (digits.length < 12) {
				return prev + num;
			}
			return prev;
		});
	}, []);

	const handleDelete = useCallback(() => {
		setPhoneNumber((prev) => prev.slice(0, -1));
	}, []);

	const handleCall = useCallback(
		(num?: string) => {
			const callingNumber = num || phoneNumber;
			const digits = callingNumber.replace(/\D/g, "");

			// 3 digits is a valid destination here: the dialplan defines 900 (AI
			// agent), 600/601/602 (echo / playback / music-on-hold), 700 (voicemail)
			// and 101-104 / 201-204 (operators). The old floor of 4 blocked all of them.
			if (digits.length < 3) {
				return;
			}

			// Short numbers are internal extensions and must go out exactly as dialled.
			// Anything longer is an Uzbek subscriber number: normalise to 998XXXXXXXXX
			// so a 9-digit local number and a 12-digit one both reach the same place.
			const target =
				digits.length <= 4 ? digits : digits.startsWith("998") ? digits : `998${digits}`;

			makeCall(target);
			onClose();
		},
		[phoneNumber, makeCall, onClose]
	);

	/** Dialplan destinations that are useful to reach from the dashboard. */
	const quickDial = INTERNAL_QUICK_DIAL;

	useEffect(() => {
		if (!open || activeTab !== "dialpad") {
			return;
		}

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key >= "0" && e.key <= "9") {
				handleNumberClick(e.key);
			} else if (e.key === "Backspace") {
				handleDelete();
			} else if (e.key === "Enter") {
				if (!isInCall) {
					handleCall();
				}
			} else if (e.key === "*" || e.key === "#") {
				handleNumberClick(e.key);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [open, activeTab, handleNumberClick, handleDelete, handleCall, isInCall]);

	return {
		activeTab,
		setActiveTab,
		phoneNumber,
		searchQuery,
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
	};
}
