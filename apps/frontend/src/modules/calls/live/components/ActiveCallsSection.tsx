import { DownOutlined, InfoCircleOutlined, ReloadOutlined, UpOutlined } from "@ant-design/icons";
import { Alert, App, Button, Tooltip } from "antd";
import { useState } from "react";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { useWsStore } from "@/shared/store/ws.store";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { formatTime as formatClock } from "@/shared/utils/datetime";
import { WS_STATUS_LABELS } from "@/shared/utils/labels";
import { useHangupCall } from "../hooks/useLiveCalls";
import { useLiveCallsBoard } from "../hooks/useLiveCallsBoard";
import type { LiveCallRow } from "../types";
import { LiveCallCard } from "./LiveCallCard";
import { LiveCallDetailPanel } from "./LiveCallDetailPanel";
import { TransferCallModal } from "./TransferCallModal";

/** Qo'ng'iroqni tugatish huquqi — backend `POST /asterisk/hangup` da ham shu ikki rol. */
const HANGUP_ROLES = ["admin", "supervisor"];

function SummaryFact({ label, value, tone }: { label: string; value: string; tone: string }) {
	return (
		<span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider">
			<span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
			<span className="text-slate-400">{label}</span>
			<span className="text-slate-600">{value}</span>
		</span>
	);
}

/**
 * Jonli qo'ng'iroqlar — qo'ng'iroqlar tarixining tepasidagi bo'lim.
 *
 * Bu ilgari alohida sahifa edi. Sahifa olib tashlandi, imkoniyat qoldi: jonli
 * transkriptni kuzatish, operatorga uzatish va qo'ng'iroqni tugatish. Bo'lim
 * faqat jonli qator bo'lganda ko'rinadi, shuning uchun odatdagi kunda tarix
 * jadvali sahifaning eng tepasida turadi.
 *
 * Xatolik holati istisno: REST so'rovi yiqilsa doska bo'sh qoladi va bo'limni
 * umuman ko'rsatmaslik "jonli qo'ng'iroq yo'q" degan yolg'on xabar bo'lardi.
 */
export function ActiveCallsSection() {
	const { message } = App.useApp();
	const user = useAuthStore((state) => state.user);
	const wsStatus = useWsStore((state) => state.status);

	const board = useLiveCallsBoard();
	const hangup = useHangupCall();

	const [isCollapsed, setIsCollapsed] = useState(false);
	const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
	const [transferTarget, setTransferTarget] = useState<LiveCallRow | null>(null);
	const [hangingUpCallId, setHangingUpCallId] = useState<string | null>(null);

	const canHangup = user !== null && HANGUP_ROLES.includes(user.role);

	// Tanlangan qator yo'qolsa (qo'ng'iroq tozalangan bo'lsa) birinchisiga o'tadi.
	const selectedRow =
		board.rows.find((row) => row.callId === selectedCallId) ?? board.rows[0] ?? null;

	const handleHangup = async (row: LiveCallRow) => {
		setHangingUpCallId(row.callId);
		try {
			const response = await hangup.mutateAsync({ callId: row.callId });
			if (response.data.hungUp) {
				message.success("Qo'ng'iroq tugatildi");
			} else {
				message.warning(response.data.message || "Qo'ng'iroqni tugatib bo'lmadi");
			}
		} catch (error) {
			message.error(getApiErrorMessage(error, "Qo'ng'iroqni tugatib bo'lmadi"));
		} finally {
			setHangingUpCallId(null);
		}
	};

	if (board.rows.length === 0 && !board.isError) {
		return null;
	}

	const aiActive = board.activeRows.filter((row) => row.aiSession?.status === "active").length;
	const transferring = board.activeRows.filter(
		(row) => row.status === "transferring" || row.status === "transferred"
	).length;
	const endedRecently = board.rows.length - board.activeRows.length;

	return (
		<section className="mb-8 overflow-hidden rounded-2xl border border-emerald-100 bg-emerald-50/40 p-5">
			<div className="mb-4 flex flex-wrap items-center justify-between gap-4">
				<div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
					<h2 className="flex items-center gap-2.5 text-lg font-black tracking-tight text-slate-900">
						<span className="relative flex h-2.5 w-2.5">
							<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
							<span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
						</span>
						Jonli qo'ng'iroqlar
						<span className="rounded-lg bg-emerald-100 px-2 py-0.5 text-sm font-black tabular-nums text-emerald-700">
							{board.activeRows.length}
						</span>
					</h2>

					<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
						<SummaryFact
							label="AI sessiya"
							value={String(aiActive)}
							tone={aiActive > 0 ? "bg-emerald-500" : "bg-slate-300"}
						/>
						<SummaryFact
							label="Uzatishda"
							value={String(transferring)}
							tone={transferring > 0 ? "bg-amber-500" : "bg-slate-300"}
						/>
						{endedRecently > 0 && (
							<SummaryFact
								label="Yaqinda tugadi"
								value={String(endedRecently)}
								tone="bg-slate-300"
							/>
						)}
						<SummaryFact
							label="Orkestrator"
							value={board.orchestratorRunning ? "Ishlayapti" : "To'xtagan"}
							tone={board.orchestratorRunning ? "bg-emerald-500" : "bg-rose-500"}
						/>
						<SummaryFact
							label="Jonli kanal"
							value={WS_STATUS_LABELS[wsStatus]}
							tone={wsStatus === "connected" ? "bg-emerald-500" : "bg-rose-500"}
						/>
					</div>
				</div>

				<div className="flex items-center gap-3">
					{board.lastEventAt && (
						<span className="hidden text-[11px] font-bold uppercase tracking-wider text-slate-400 sm:block">
							Oxirgi hodisa {formatClock(board.lastEventAt)}
						</span>
					)}
					<Tooltip title="Yangilash">
						<Button
							icon={<ReloadOutlined />}
							loading={board.isFetching}
							onClick={board.refetch}
							className="h-10 w-10 rounded-xl"
						/>
					</Tooltip>
					<Button
						icon={isCollapsed ? <DownOutlined /> : <UpOutlined />}
						onClick={() => setIsCollapsed((collapsed) => !collapsed)}
						className="h-10 rounded-xl font-bold"
					>
						{isCollapsed ? "Yoyish" : "Yig'ish"}
					</Button>
				</div>
			</div>

			{board.isError && (
				<Alert
					type="error"
					showIcon
					className="mb-4 rounded-2xl"
					message="Jonli qo'ng'iroqlarni yuklab bo'lmadi"
					description={board.errorMessage ?? "Server javob bermadi."}
					action={
						<Button size="small" onClick={board.refetch}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			{board.scopedToOperator && !isCollapsed && (
				<Alert
					type="info"
					showIcon
					icon={<InfoCircleOutlined />}
					className="mb-4 rounded-2xl"
					message="Faqat sizga tegishli qo'ng'iroqlar ko'rsatilmoqda"
					description="Operator sifatida siz o'zingizga uzatilgan qo'ng'iroqlarni ko'rasiz."
				/>
			)}

			{wsStatus !== "connected" && !isCollapsed && (
				<Alert
					type="warning"
					showIcon
					className="mb-4 rounded-2xl"
					message="Jonli kanal ulanmagan"
					description="WebSocket uzilgan — bo'lim har 10 sekundda so'rov orqali yangilanadi, transkript esa kechikishi mumkin."
				/>
			)}

			{!isCollapsed && board.rows.length > 0 && (
				<div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
					<div className="space-y-4 xl:col-span-5">
						{board.rows.map((row) => (
							<LiveCallCard
								key={row.callId}
								row={row}
								nowMs={board.nowMs}
								isSelected={selectedRow?.callId === row.callId}
								onSelect={setSelectedCallId}
								onTransfer={setTransferTarget}
								onHangup={handleHangup}
								canHangup={canHangup}
								isHangingUp={hangingUpCallId === row.callId}
							/>
						))}
					</div>

					<div className="xl:col-span-7">
						<LiveCallDetailPanel
							row={selectedRow}
							nowMs={board.nowMs}
							canHangup={canHangup}
							isHangingUp={hangingUpCallId === selectedRow?.callId}
							onTransfer={setTransferTarget}
							onHangup={handleHangup}
						/>
					</div>
				</div>
			)}

			<TransferCallModal
				open={transferTarget !== null}
				call={transferTarget}
				onClose={() => setTransferTarget(null)}
			/>
		</section>
	);
}
