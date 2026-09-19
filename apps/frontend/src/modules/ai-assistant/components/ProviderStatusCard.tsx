import {
	ApiOutlined,
	CheckCircleOutlined,
	CloseCircleOutlined,
	KeyOutlined,
	ReloadOutlined,
	StopOutlined,
	ThunderboltOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Skeleton, Tag } from "antd";
import type { ReactNode } from "react";
import type { AiProviderStatus } from "../types";
import { formatDateTime, providerLabel } from "../utils/labels";

interface Props {
	status: AiProviderStatus | undefined;
	isLoading: boolean;
	isFetching: boolean;
	isError: boolean;
	errorMessage: string | null;
	onRefresh: () => void;
}

/** Sarlavha kartasi — yuklanish va xato holatlari bir xil oq kartada ko'rinadi. */
function ShellCard({ children }: { children: ReactNode }) {
	return <Card className="border-none shadow-sm rounded-2xl overflow-hidden">{children}</Card>;
}

export function ProviderStatusCard({
	status,
	isLoading,
	isFetching,
	isError,
	errorMessage,
	onRefresh,
}: Props) {
	if (isLoading) {
		return (
			<ShellCard>
				<Skeleton active paragraph={{ rows: 4 }} />
			</ShellCard>
		);
	}

	if (isError || !status) {
		return (
			<ShellCard>
				<Alert
					type="error"
					showIcon
					icon={<CloseCircleOutlined className="text-rose-500" />}
					className="rounded-xl border-rose-200 bg-rose-50"
					message={
						<span className="font-bold text-rose-600">Provayder holatini olib bo'lmadi</span>
					}
					description={
						<span className="text-slate-600">{errorMessage ?? "Server javob bermadi."}</span>
					}
					action={
						<Button size="small" onClick={onRefresh} className="rounded-lg font-bold">
							Qayta urinish
						</Button>
					}
				/>
			</ShellCard>
		);
	}

	const isAvailable = status.available;
	const isDisabled = !status.enabled;

	// Yashil chiroq faqat provayder haqiqatan ishlayotganda va yoqilganda.
	const tone = isDisabled
		? {
				label: "O'chirilgan",
				tagColor: "orange",
				alertType: "warning" as const,
				alertClass: "border-amber-200 bg-amber-50",
				iconClass: "text-amber-500",
				textClass: "text-amber-600",
				icon: <StopOutlined />,
			}
		: isAvailable
			? {
					label: "Mavjud",
					tagColor: "green",
					alertType: "success" as const,
					alertClass: "border-emerald-200 bg-emerald-50",
					iconClass: "text-emerald-500",
					textClass: "text-emerald-600",
					icon: <CheckCircleOutlined />,
				}
			: {
					label: "Mavjud emas",
					tagColor: "red",
					alertType: "error" as const,
					alertClass: "border-rose-200 bg-rose-50",
					iconClass: "text-rose-500",
					textClass: "text-rose-600",
					icon: <CloseCircleOutlined />,
				};

	const isReady = isAvailable && !isDisabled;

	return (
		<Card
			className="border-none shadow-sm rounded-2xl overflow-hidden"
			title={
				<div className="flex items-center gap-3">
					<div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
						<ApiOutlined />
					</div>
					<div className="min-w-0">
						<div className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] leading-none mb-1">
							Ovozli AI provayderi
						</div>
						<div className="text-base font-black text-slate-900 tracking-tight leading-none truncate">
							{providerLabel(status.provider)}
						</div>
					</div>
				</div>
			}
			extra={
				<div className="flex items-center gap-3">
					<Tag
						icon={tone.icon}
						color={tone.tagColor}
						className="m-0 rounded-lg border-none px-3 py-1 text-xs font-bold"
					>
						{tone.label}
					</Tag>
					<Button
						icon={<ReloadOutlined />}
						loading={isFetching}
						onClick={onRefresh}
						className="h-10 rounded-xl font-bold"
					>
						Tekshirish
					</Button>
				</div>
			}
		>
			{/* Backend bergan sabab matni aynan shu ko'rinishda. */}
			<Alert
				type={tone.alertType}
				showIcon
				icon={<span className={tone.iconClass}>{tone.icon}</span>}
				className={`mb-5 rounded-xl ${tone.alertClass}`}
				message={
					<span className={`font-bold ${tone.textClass}`}>
						{isReady ? "Ovozli sessiya ochilishi mumkin" : "Ovozli sessiya ochilmaydi"}
					</span>
				}
				description={
					<div className="space-y-2">
						<div className="text-[9px] font-black uppercase tracking-widest text-slate-400">
							Sabab (server javobi)
						</div>
						<pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-slate-100 bg-white p-3 font-mono text-xs leading-relaxed text-slate-700">
							{status.detail}
						</pre>
					</div>
				}
			/>

			{isDisabled && (
				<Alert
					type="info"
					showIcon
					className="mb-5 rounded-xl border-blue-100 bg-blue-50"
					message={<span className="font-bold text-blue-600">AI agent o'chirilgan</span>}
					description={
						<span className="text-slate-600">
							AI_AGENT_ENABLED false — kiruvchi qo'ng'iroqlar AI operatorga topshirilmaydi.
						</span>
					}
				/>
			)}

			{/*
			 * OpenAI kaliti yo'qligining oqibati qaysi provayder ishlayotganiga
			 * bog'liq. Avval bu yerda doim «faqat zaxira IVR ishlaydi» deyilardi —
			 * Gemini'da ishlayotgan tizim uchun bu noto'g'ri: ovoz mukammal
			 * ishlaydi, faqat qo'ng'iroqdan keyingi tahlil bajarilmaydi (u OpenAI
			 * matn modelida).
			 */}
			{!status.apiKeyConfigured &&
				(status.provider === "gemini-live" ? (
					<Alert
						type="warning"
						showIcon
						icon={<KeyOutlined className="text-amber-500" />}
						className="mb-5 rounded-xl border-amber-200 bg-amber-50"
						message={<span className="font-bold text-amber-600">OPENAI_API_KEY sozlanmagan</span>}
						description={
							<span className="text-slate-600">
								Ovozli suhbatga ta'sir qilmaydi — u Gemini Live orqali ishlaydi. Ammo qo'ng'iroqdan
								keyingi tahlil (xulosa, kayfiyat, kategoriyalar) OpenAI matn modelida bajariladi va
								kalitsiz ishlamaydi.
							</span>
						}
					/>
				) : (
					<Alert
						type="error"
						showIcon
						icon={<KeyOutlined className="text-rose-500" />}
						className="mb-5 rounded-xl border-rose-200 bg-rose-50"
						message={<span className="font-bold text-rose-600">OPENAI_API_KEY sozlanmagan</span>}
						description={
							<span className="text-slate-600">
								Kalit qo'shilmaguncha faqat zaxira IVR ishlaydi.
							</span>
						}
					/>
				))}

			{/*
			 * Model, ovoz, til va ichki raqam ataylab bu yerda ko'rsatilmaydi: ular
			 * quyidagi sozlamalar bo'limida tahrirlanadi va bitta qiymatning ikkita
			 * ko'rinishi ertami-kechmi bir-biriga zid gapiradi.
			 */}
			<div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
				<ThunderboltOutlined className="text-slate-400" />
				<span className="text-xs font-bold text-slate-500">Orkestrator</span>
				<Tag
					color={status.orchestrator.running ? "green" : "red"}
					className="m-0 rounded-lg border-none text-[11px] font-bold"
				>
					{status.orchestrator.running ? "Ishlayapti" : "To'xtagan"}
				</Tag>
				<span className="text-xs font-semibold text-slate-400">
					Faol qo'ng'iroqlar: {status.orchestrator.activeCalls}
				</span>
				<span className="ml-auto text-xs font-semibold text-slate-400">
					Tekshirildi: {formatDateTime(status.checkedAt)}
				</span>
			</div>
		</Card>
	);
}
