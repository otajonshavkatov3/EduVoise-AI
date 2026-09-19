import {
	CalendarOutlined,
	CheckSquareOutlined,
	CustomerServiceOutlined,
	EditOutlined,
	SwapOutlined,
	ThunderboltOutlined,
} from "@ant-design/icons";
import { Card, Empty, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BookingStatusTag } from "@/modules/bookings/components/BookingStatusTag";
import { FollowUpStatusTag } from "@/modules/follow-ups/components/FollowUpStatusTag";
import { TicketPriorityTag } from "@/modules/tickets/components/TicketPriorityTag";
import { TicketStatusBadge } from "@/modules/tickets/components/TicketStatusBadge";
import { formatDateTime } from "@/shared/utils/datetime";
import type {
	CallFullActions,
	CallFullBooking,
	CallFullFollowUp,
	CallFullNote,
	CallFullTicket,
	CallFullTransfer,
} from "../../types/callFull";
import { SectionTitle } from "../analysis/SectionTitle";

const { Text } = Typography;

/**
 * Uzatish holati — bu yerdan boshqa hech qayerda ko'rsatilmaydi, shuning uchun
 * o'z jadvali. Qolgan to'rt turning teglari o'z modullaridan olinadi, aks holda
 * bir xil holat ikki sahifada ikki xil nomlanib qolardi.
 */
const TRANSFER_STATUS_LABELS: Record<CallFullTransfer["status"], { label: string; color: string }> =
	{
		requested: { label: "So'ralgan", color: "default" },
		ringing: { label: "Chalinmoqda", color: "blue" },
		connected: { label: "Ulandi", color: "green" },
		failed: { label: "Ulanmadi", color: "red" },
		abandoned: { label: "Tashlab ketilgan", color: "orange" },
	};

const NOTE_AUTHOR_LABELS: Record<CallFullNote["authorType"], string> = {
	ai: "AI yozgan",
	operator: "Operator yozgan",
	system: "Tizim yozgan",
};

/** AI yaratgan yozuvni operator kiritganidan ajratadi. */
function AuthorTag({ createdBySystem }: { createdBySystem: boolean }) {
	return createdBySystem ? (
		<Tag
			icon={<ThunderboltOutlined />}
			className="m-0 rounded-lg border-purple-100 bg-purple-50 text-[10px] font-bold text-purple-600"
		>
			AI yaratgan
		</Tag>
	) : (
		<Tag className="m-0 rounded-lg border-slate-200 bg-slate-50 text-[10px] font-bold text-slate-500">
			Qo'lda kiritilgan
		</Tag>
	);
}

function Row({
	icon,
	title,
	titleLink,
	tags,
	body,
	facts,
}: {
	icon: ReactNode;
	title: string;
	titleLink?: string;
	tags: ReactNode;
	body?: string | null;
	facts?: ReactNode;
}) {
	return (
		<div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="text-slate-400">{icon}</span>
					{titleLink ? (
						<Link to={titleLink} className="truncate text-sm font-black text-blue-600">
							{title}
						</Link>
					) : (
						<span className="truncate text-sm font-black text-slate-800">{title}</span>
					)}
				</div>
				<Space size={[6, 6]} wrap>
					{tags}
				</Space>
			</div>

			{body && (
				<Text className="mt-2 block whitespace-pre-line text-xs font-medium leading-relaxed text-slate-600">
					{body}
				</Text>
			)}

			{facts && (
				<div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] font-medium text-slate-500">
					{facts}
				</div>
			)}
		</div>
	);
}

function TicketBlock({ ticket }: { ticket: CallFullTicket }) {
	return (
		<div>
			<SectionTitle>Murojaat</SectionTitle>
			<div className="mt-2">
				<Row
					icon={<CustomerServiceOutlined />}
					title={ticket.subject}
					titleLink={`/tickets/${ticket.id}`}
					tags={
						<>
							<TicketStatusBadge status={ticket.status} />
							<TicketPriorityTag priority={ticket.priority} />
							{ticket.category && (
								<Tag className="m-0 rounded-lg border-slate-200 bg-white text-[10px] font-bold text-slate-500">
									{ticket.category}
								</Tag>
							)}
						</>
					}
					body={ticket.description}
					facts={
						<>
							<span>Yaratilgan: {formatDateTime(ticket.createdAt)}</span>
							{ticket.closedAt && <span>Yopilgan: {formatDateTime(ticket.closedAt)}</span>}
							{ticket.externalRefId && <span>Tashqi raqam: {ticket.externalRefId}</span>}
						</>
					}
				/>
			</div>
		</div>
	);
}

function TransfersBlock({ transfers }: { transfers: CallFullTransfer[] }) {
	return (
		<div>
			<SectionTitle>Odamga uzatish ({transfers.length})</SectionTitle>
			<div className="mt-2 space-y-3">
				{transfers.map((transfer) => {
					const status = TRANSFER_STATUS_LABELS[transfer.status];
					return (
						<Row
							key={transfer.id}
							icon={<SwapOutlined />}
							title={transfer.toOperator?.name ?? `Ichki raqam ${transfer.toExtension}`}
							tags={
								<>
									<Tag
										color={status.color}
										className="m-0 rounded-lg border-none text-[10px] font-bold"
									>
										{status.label}
									</Tag>
									<Tag className="m-0 rounded-lg border-slate-200 bg-white font-mono text-[10px] text-slate-500">
										#{transfer.toExtension}
									</Tag>
								</>
							}
							body={transfer.reason}
							facts={
								<>
									<span>So'ralgan: {formatDateTime(transfer.requestedAt)}</span>
									{transfer.waitSeconds !== null && <span>Kutish: {transfer.waitSeconds} s</span>}
									{transfer.talkSeconds !== null && <span>Suhbat: {transfer.talkSeconds} s</span>}
								</>
							}
						/>
					);
				})}
			</div>
		</div>
	);
}

function FollowUpsBlock({ items }: { items: CallFullFollowUp[] }) {
	return (
		<div>
			<div className="flex items-center justify-between">
				<SectionTitle>Keyingi ish ({items.length})</SectionTitle>
				<Link to="/follow-ups" className="text-[11px] font-bold text-blue-600">
					Ro'yxatda ochish
				</Link>
			</div>
			<div className="mt-2 space-y-3">
				{items.map((item) => (
					<Row
						key={item.id}
						icon={<CheckSquareOutlined />}
						title={item.title}
						tags={
							<>
								<FollowUpStatusTag status={item.status} />
								{item.isOverdue && (
									<Tag className="m-0 rounded-lg border-rose-100 bg-rose-50 text-[10px] font-bold text-rose-600">
										Muddati o'tgan
									</Tag>
								)}
								<AuthorTag createdBySystem={item.createdBySystem} />
							</>
						}
						body={item.description}
						facts={
							<>
								{item.dueAt && <span>Muddat: {formatDateTime(item.dueAt)}</span>}
								{item.assignee && <span>Mas'ul: {item.assignee.name}</span>}
								{item.completedAt && <span>Bajarilgan: {formatDateTime(item.completedAt)}</span>}
								{item.ticketId && (
									<Link to={`/tickets/${item.ticketId}`} className="font-bold text-blue-600">
										Murojaatga o'tish
									</Link>
								)}
							</>
						}
					/>
				))}
			</div>
		</div>
	);
}

function BookingsBlock({ items }: { items: CallFullBooking[] }) {
	return (
		<div>
			<div className="flex items-center justify-between">
				<SectionTitle>Uchrashuv ({items.length})</SectionTitle>
				<Link to="/bookings" className="text-[11px] font-bold text-blue-600">
					Kalendarda ochish
				</Link>
			</div>
			<div className="mt-2 space-y-3">
				{items.map((item) => (
					<Row
						key={item.id}
						icon={<CalendarOutlined />}
						title={item.title}
						tags={
							<>
								<BookingStatusTag status={item.status} />
								<AuthorTag createdBySystem={item.createdBySystem} />
							</>
						}
						body={item.notes}
						facts={
							<>
								<span>
									{formatDateTime(item.scheduledAt)} — {formatDateTime(item.endsAt)}
								</span>
								<span>{item.durationMinutes} daqiqa</span>
								{item.location && <span>Joy: {item.location}</span>}
								{item.assignee && <span>Mas'ul: {item.assignee.name}</span>}
							</>
						}
					/>
				))}
			</div>
		</div>
	);
}

function NotesBlock({ items }: { items: CallFullNote[] }) {
	return (
		<div>
			<SectionTitle>Izohlar ({items.length})</SectionTitle>
			<div className="mt-2 space-y-3">
				{items.map((note) => (
					<Row
						key={note.id}
						icon={<EditOutlined />}
						title={note.author?.name ?? NOTE_AUTHOR_LABELS[note.authorType]}
						tags={
							<Tag className="m-0 rounded-lg border-slate-200 bg-white text-[10px] font-bold text-slate-500">
								{NOTE_AUTHOR_LABELS[note.authorType]}
							</Tag>
						}
						body={note.content}
						facts={
							<>
								<span>Yozilgan: {formatDateTime(note.createdAt)}</span>
								{note.updatedAt !== note.createdAt && (
									<span>Tuzatilgan: {formatDateTime(note.updatedAt)}</span>
								)}
							</>
						}
					/>
				))}
			</div>
		</div>
	);
}

/**
 * Qo'ng'iroq davomida bajarilgan ishlar.
 *
 * Murojaat muallifi ko'rsatilmaydi: `tickets.created_by` javobgar odamni
 * saqlaydi, muallifni emas — uni "supervisor yaratdi" deb chizish AI yozgan
 * murojaatda yolg'on bo'lardi. Qolgan to'rt turda muallif ma'lum va ko'rsatiladi.
 */
export function CallActionsCard({ actions }: { actions: CallFullActions }) {
	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<Space size="small">
					<CheckSquareOutlined className="text-indigo-500" />
					<span className="text-xs font-black uppercase tracking-widest">
						Qo'ng'iroqda nima qilingan
					</span>
				</Space>
			}
		>
			{actions.isEmpty ? (
				<Empty
					className="py-6"
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={
						<div className="space-y-1">
							<div className="text-sm font-bold text-slate-500">
								Hech qanday yozuv qoldirilmagan
							</div>
							<div className="text-xs font-medium text-slate-400">
								Bu qo'ng'iroqdan murojaat, uchrashuv, keyingi ish, uzatish yoki izoh chiqmagan.
							</div>
						</div>
					}
				/>
			) : (
				<div className="space-y-6">
					{actions.ticket && <TicketBlock ticket={actions.ticket} />}
					{actions.transfers.length > 0 && <TransfersBlock transfers={actions.transfers} />}
					{actions.followUps.length > 0 && <FollowUpsBlock items={actions.followUps} />}
					{actions.bookings.length > 0 && <BookingsBlock items={actions.bookings} />}
					{actions.notes.length > 0 && <NotesBlock items={actions.notes} />}
				</div>
			)}
		</Card>
	);
}
