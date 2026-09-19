import { RobotOutlined } from "@ant-design/icons";
import { Alert } from "antd";
import { useEffect } from "react";
import { TranscriptStream } from "@/modules/calls/live/components/TranscriptStream";
import { useLiveCallDetail } from "@/modules/calls/live/hooks/useLiveCalls";
import { useLiveCallsStore } from "@/modules/calls/live/store/liveCalls.store";
import type { TranscriptEntry } from "@/modules/calls/live/types";

/**
 * Zustand selektori har chaqiruvda bir xil havolani qaytarishi kerak, aks holda
 * cheksiz qayta render bo'ladi — shu sababli bo'sh ro'yxat modul darajasida.
 */
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];

interface Props {
	/** Bog'langan backend qo'ng'iroq id'si (WS/incoming_call orqali) yoki null. */
	callId: string | null;
}

/**
 * Iliq uzatish: operator jiringlayotgan panelda AI bilan bo'lgan suhbatni va
 * uzatish sababi/xulosasini ko'radi — shunda mijoz aytib bo'lgan narsani qayta
 * so'ramaydi.
 *
 * Ma'lumot manbai jonli qo'ng'iroqlar doskasi bilan AYNAN bir xil: `callId`
 * bo'yicha transkript oqimi (WS deltalari MainLayout orqali store'ga tushadi) +
 * bir martalik REST seed. Ko'rsatadigan narsa bo'lmasa hech nima chiqarilmaydi
 * (xatosiz) — oddiy, AI ishtirokisiz qo'ng'iroqlar uchun panel o'zgarmaydi.
 */
export function CallPopTranscript({ callId }: Props) {
	const detail = useLiveCallDetail(callId);
	const seedTranscript = useLiveCallsStore((state) => state.seedTranscript);
	const transcript = useLiveCallsStore((state) =>
		callId ? (state.transcripts[callId] ?? EMPTY_TRANSCRIPT) : EMPTY_TRANSCRIPT
	);
	const summary = useLiveCallsStore((state) =>
		callId ? (state.calls[callId]?.aiSummary ?? null) : null
	);
	const transferReason = useLiveCallsStore((state) =>
		callId ? (state.calls[callId]?.transferReason ?? null) : null
	);

	// REST'dagi saqlangan transkriptni bir marta store'ga urug'lantiramiz; keyingi
	// qatorlar WS deltalari orqali keladi (LiveCallDetailPanel bilan bir xil naqsh).
	useEffect(() => {
		const data = detail.data?.data;
		if (!data) {
			return;
		}
		seedTranscript(data.callId, data.transcript);
	}, [detail.data, seedTranscript]);

	const reason = transferReason ?? summary;

	// Bog'lanmagan yoki ko'rsatadigan narsa yo'q — panelga hech nima qo'shmaymiz.
	if (!callId || (transcript.length === 0 && !reason)) {
		return null;
	}

	return (
		<div className="rounded-2xl border border-blue-100 bg-blue-50/40 p-3">
			<div className="mb-2 flex items-center gap-2">
				<RobotOutlined className="text-blue-600" />
				<span className="text-[11px] font-black uppercase tracking-wider text-blue-700">
					AI suhbati
				</span>
			</div>

			{reason && (
				<Alert
					type="info"
					showIcon
					icon={<RobotOutlined />}
					className="mb-2 rounded-xl"
					message={transferReason ? "Uzatish sababi" : "AI xulosasi"}
					description={reason}
				/>
			)}

			{transcript.length > 0 && (
				<TranscriptStream
					entries={transcript}
					isLoading={detail.isLoading}
					heightClass="h-[200px]"
				/>
			)}
		</div>
	);
}
