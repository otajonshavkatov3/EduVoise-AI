import { CheckCircleOutlined } from "@ant-design/icons";
import { message } from "antd";
import { useCallback, useState } from "react";
import { useOperators } from "@/modules/operators/hooks/useOperators";
import { useSipPhoneContext } from "../providers/SipPhoneProvider";

export type TransferMode = "blind" | "attended";
export type AttendedStep = "select" | "consulting";

export function useCallTransferModal(onClose: () => void, onBeforeTransfer?: () => void) {
	const [mode, setMode] = useState<TransferMode>("blind");
	const [attendedStep, setAttendedStep] = useState<AttendedStep>("select");
	const [searchQuery, setSearchQuery] = useState("");
	const [customNumber, setCustomNumber] = useState("");
	const [isTransferring, setIsTransferring] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [consultingWith, setConsultingWith] = useState<string | null>(null);

	const { data: operatorsData, isLoading } = useOperators({ limit: 50 });
	const {
		activeCall,
		blindTransfer,
		startConsultation,
		cancelConsultation,
		completeAttendedTransfer,
	} = useSipPhoneContext();

	const isCallEstablished = activeCall?.status === "established";

	const handleClose = useCallback(() => {
		// Konsultatsiya ochiq bo'lsa uni haqiqatan uzish kerak. Faqat React
		// holatini tozalash hamkasb bilan suhbatni jonli qoldirib, mijozni
		// jimlatilgan holda tashlab ketardi — operator uchun qo'ng'iroq o'lganday
		// ko'rinardi. Muvaffaqiyatli transferdan keyin sessiya allaqachon yo'q,
		// shuning uchun bu chaqiruv o'sha holatda faqat hold'ni tozalaydi.
		if (attendedStep === "consulting") {
			cancelConsultation().catch(() => {
				/* Uzish xatosi holatni tiklashga to'sqinlik qilmasligi kerak. */
			});
		}

		setMode("blind");
		setAttendedStep("select");
		setSearchQuery("");
		setCustomNumber("");
		setIsTransferring(false);
		setError(null);
		setConsultingWith(null);
		onClose();
	}, [attendedStep, cancelConsultation, onClose]);

	const handleBlindTransfer = useCallback(
		async (extension: string, label: string) => {
			if (!isCallEstablished) {
				setError("Faqat aktiv (o'rnatilgan) qo'ng'iroqni o'tkazish mumkin");
				return;
			}
			setIsTransferring(true);
			setError(null);
			if (onBeforeTransfer) {
				onBeforeTransfer();
			}

			try {
				const result = await blindTransfer(extension);
				if (result.success) {
					message.success({
						content: `Qo'ng'iroq ${label} (${extension}) ga muvaffaqiyatli yo'naltirildi`,
						icon: <CheckCircleOutlined />,
					});
					handleClose();
				} else {
					setError(result.error || "Qo'ng'iroqni uzatib bo'lmadi");
				}
			} finally {
				setIsTransferring(false);
			}
		},
		[isCallEstablished, blindTransfer, handleClose, onBeforeTransfer]
	);

	const handleStartConsultation = useCallback(
		async (extension: string, label: string) => {
			if (!isCallEstablished) {
				setError("Faqat aktiv qo'ng'iroqni o'tkazish mumkin");
				return;
			}
			setIsTransferring(true);
			setError(null);
			if (onBeforeTransfer) {
				onBeforeTransfer();
			}

			try {
				const result = await startConsultation(extension);
				if (result.success) {
					setConsultingWith(`${label} (${extension})`);
					setAttendedStep("consulting");
					message.info(
						`${label} ga konsultatsiya qo'ng'iroq boshlandi. Asosiy qo'ng'iroq hold-da.`
					);
				} else {
					setError(result.error || "Konsultatsiya boshlash amalga oshmadi");
				}
			} finally {
				setIsTransferring(false);
			}
		},
		[isCallEstablished, startConsultation, onBeforeTransfer]
	);

	const handleCompleteAttended = useCallback(async () => {
		setIsTransferring(true);
		setError(null);
		if (onBeforeTransfer) {
			onBeforeTransfer();
		}

		try {
			const result = await completeAttendedTransfer();
			if (result.success) {
				message.success({
					content: "Qo'ng'iroq uzatildi",
					icon: <CheckCircleOutlined />,
				});
				handleClose();
			} else {
				setError(result.error || "Uzatishni yakunlab bo'lmadi");
			}
		} finally {
			setIsTransferring(false);
		}
	}, [completeAttendedTransfer, handleClose, onBeforeTransfer]);

	const handleTransferTarget = useCallback(
		(extension: string, label: string) => {
			if (mode === "blind") {
				handleBlindTransfer(extension, label);
			} else if (attendedStep === "select") {
				handleStartConsultation(extension, label);
			}
		},
		[mode, attendedStep, handleBlindTransfer, handleStartConsultation]
	);

	const getActionLabel = () => {
		if (mode === "blind") {
			return "Uzatish";
		}
		if (attendedStep === "select") {
			return "Konsultatsiya boshlash";
		}
		return "Uzatishni yakunlash";
	};

	const operators = (operatorsData?.data.items || []).filter((op) => {
		if (!searchQuery) {
			return true;
		}
		const q = searchQuery.toLowerCase();
		return op.extension?.toLowerCase().includes(q) || op.user?.phone?.toLowerCase().includes(q);
	});

	return {
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
	};
}
