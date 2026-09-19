import { EnvironmentOutlined, PhoneOutlined, UserOutlined } from "@ant-design/icons";
import { Spin, Typography } from "antd";
import { formatPhone } from "@/shared/utils/phoneFormat";
import type { IncomingCall } from "../../store/callPop.store";
import { formatAddress } from "../../utils/address";

const { Title, Text } = Typography;

interface CallerInfoProps {
	call: IncomingCall;
	searchNumber: string;
	isLoadingContact: boolean;
}

export function CallerInfo({ call, searchNumber, isLoadingContact }: CallerInfoProps) {
	const hasContact = !!call.contact?.id;

	return (
		<div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
			<ContactHeader
				hasContact={hasContact}
				isLoading={isLoadingContact}
				contactName={call.contact?.contactName}
				searchNumber={searchNumber}
			/>

			<div className="space-y-2">
				<InfoField icon={<PhoneOutlined />} label="Telefon" value={formatPhone(searchNumber)} />

				{call.contact?.address && (
					<InfoField
						icon={<EnvironmentOutlined />}
						label="Manzil"
						value={formatAddress(call.contact.address)}
						alignStart
					/>
				)}

				{call.contact?.notes && <NotesBadge notes={call.contact.notes} />}
			</div>
		</div>
	);
}

// ─── Sub-components ────────────────────────────────────────────────

function ContactHeader({
	hasContact,
	isLoading,
	contactName,
	searchNumber,
}: {
	hasContact: boolean;
	isLoading: boolean;
	contactName?: string | null;
	searchNumber: string;
}) {
	return (
		<div className="mb-3">
			<Text className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-0.5">
				{hasContact ? "Mijoz" : "Noma'lum raqam"}
			</Text>
			{isLoading ? (
				<div className="flex items-center gap-2 mt-1">
					<Spin size="small" />
					<span className="text-sm text-slate-400 font-medium">Kontakt qidirilmoqda...</span>
				</div>
			) : (
				<div className="flex items-center gap-2">
					<div
						className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
							hasContact ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-400"
						}`}
					>
						<UserOutlined className="text-sm" />
					</div>
					<div>
						<Title level={5} className="mb-0! font-black text-slate-900 leading-tight">
							{contactName || formatPhone(searchNumber)}
						</Title>
						{hasContact && (
							<Text className="text-[10px] text-emerald-600 font-bold">✓ Kontakt topildi</Text>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function InfoField({
	icon,
	label,
	value,
	alignStart,
}: {
	icon: React.ReactNode;
	label: string;
	value: string;
	alignStart?: boolean;
}) {
	return (
		<div className={`flex ${alignStart ? "items-start" : "items-center"} gap-2`}>
			<span className={`text-blue-500 text-xs shrink-0 ${alignStart ? "mt-1" : ""}`}>{icon}</span>
			<div>
				<Text className="text-[8px] font-bold text-slate-300 uppercase tracking-widest block">
					{label}
				</Text>
				<Text className="font-bold text-slate-700 text-[11px] leading-snug">{value}</Text>
			</div>
		</div>
	);
}

function NotesBadge({ notes }: { notes: string }) {
	return (
		<div className="mt-2 bg-amber-50 border border-amber-100 rounded-xl p-2">
			<Text className="text-[9px] font-black text-amber-600 uppercase tracking-widest block mb-0.5">
				Eslatma
			</Text>
			<Text className="text-[11px] text-amber-800 font-medium leading-snug">{notes}</Text>
		</div>
	);
}
