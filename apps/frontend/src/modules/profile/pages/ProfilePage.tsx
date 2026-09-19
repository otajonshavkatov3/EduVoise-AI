import {
	CalendarOutlined,
	ClockCircleOutlined,
	IdcardOutlined,
	LoginOutlined,
	MailOutlined,
	PhoneOutlined,
	ReloadOutlined,
	SafetyCertificateOutlined,
	SyncOutlined,
	TeamOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Alert, Avatar, Button, Card, Empty, Skeleton } from "antd";
import { OperatorStatusTag } from "@/modules/operators/components/OperatorStatusTag";
import { UserRoleTag } from "@/modules/users/components/UserRoleTag";
import { UserStatusTag } from "@/modules/users/components/UserStatusTag";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { EMPTY_VALUE, formatDateTime as formatSharedDateTime } from "@/shared/utils/datetime";
import { formatPhone } from "@/shared/utils/phoneFormat";
import { ChangePasswordCard } from "../components/ChangePasswordCard";
import { ProfileField } from "../components/ProfileField";
import { useMyProfile } from "../hooks/useProfile";

/** Sana + vaqtni mahalliy formatda ko'rsatish. Qiymat bo'lmasa undefined. */
/** `undefined` qaytaradi, "—" emas: bo'sh qiymatni `ProfileField` o'zi yozadi. */
function formatDateTime(value: string | null | undefined): string | undefined {
	const formatted = formatSharedDateTime(value);
	return formatted === EMPTY_VALUE ? undefined : formatted;
}

export default function ProfilePage() {
	const { data: profile, isLoading, isFetching, isError, error, refetch } = useMyProfile();

	return (
		<div className="animate-fadeIn">
			{/* Sahifa sarlavhasi */}
			<div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-center">
				<div>
					<h1 className="text-3xl font-black tracking-tight text-slate-900">Mening profilim</h1>
					<p className="font-medium text-slate-500">Hisob ma'lumotlari va operator sozlamalari</p>
				</div>
				<Button
					icon={<ReloadOutlined />}
					onClick={() => refetch()}
					loading={isFetching}
					className="h-11 rounded-xl px-5 font-bold"
				>
					Yangilash
				</Button>
			</div>

			{isError && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Profilni yuklab bo'lmadi"
					description={getApiErrorMessage(error, "Server bilan aloqa yo'q")}
					action={
						<Button size="small" onClick={() => refetch()}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			{isLoading && (
				<div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
					<Card className="xl:col-span-7">
						<Skeleton active avatar paragraph={{ rows: 6 }} />
					</Card>
					<Card className="xl:col-span-5">
						<Skeleton active paragraph={{ rows: 4 }} />
					</Card>
				</div>
			)}

			{!(isLoading || isError || profile) && (
				<Card>
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description={
							<div className="text-center">
								<div className="font-bold text-slate-500">Profil ma'lumotlari topilmadi</div>
								<div className="mt-1 text-xs text-slate-400">
									Hisobingiz o'chirilgan bo'lishi mumkin — administrator bilan bog'laning
								</div>
							</div>
						}
					/>
				</Card>
			)}

			{profile && (
				<div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
					{/* Hisob ma'lumotlari */}
					<Card
						className="xl:col-span-7"
						title={
							<div className="flex items-center gap-2 font-bold text-[#0f172a]">
								<IdcardOutlined className="text-[#2154b2]" />
								Hisob ma'lumotlari
							</div>
						}
					>
						<div className="mb-5 flex items-center gap-4 border-b border-[#f1f5f9] pb-5">
							<Avatar
								size={64}
								icon={<UserOutlined />}
								className="border-2 border-white bg-blue-100 text-blue-600 shadow-sm"
							/>
							<div className="min-w-0">
								<div className="truncate text-xl font-black text-[#0f172a]">
									{profile.username || formatPhone(profile.phone)}
								</div>
								<div className="mt-1.5 flex flex-wrap items-center gap-2">
									<UserRoleTag role={profile.role} />
									<UserStatusTag isActive={profile.isActive} />
								</div>
							</div>
						</div>

						<ProfileField
							label="Telefon raqami"
							icon={<PhoneOutlined />}
							value={formatPhone(profile.phone)}
							mono
						/>
						<ProfileField
							label="Foydalanuvchi nomi"
							icon={<UserOutlined />}
							value={profile.username}
							emptyText="Kiritilmagan"
						/>
						<ProfileField
							label="Elektron pochta"
							icon={<MailOutlined />}
							value={profile.email}
							emptyText="Kiritilmagan"
						/>
						<ProfileField
							label="Roli"
							icon={<SafetyCertificateOutlined />}
							value={<UserRoleTag role={profile.role} />}
						/>
						<ProfileField
							label="Oxirgi kirish"
							icon={<LoginOutlined />}
							value={formatDateTime(profile.lastLoginAt)}
							emptyText="Ma'lumot yo'q"
						/>
						<ProfileField
							label="Hisob yaratilgan"
							icon={<CalendarOutlined />}
							value={formatDateTime(profile.createdAt)}
						/>
					</Card>

					{/* Operator profili */}
					<Card
						className="xl:col-span-5"
						title={
							<div className="flex items-center gap-2 font-bold text-[#0f172a]">
								<TeamOutlined className="text-[#2154b2]" />
								Operator profili
							</div>
						}
					>
						{profile.operator ? (
							<>
								<div className="mb-4 rounded-2xl bg-[#f8fafc] p-4 text-center">
									<div className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]">
										Ichki raqam (extension)
									</div>
									<div className="mt-1 font-mono text-3xl font-black text-[#2154b2]">
										{profile.operator.extension}
									</div>
								</div>

								<ProfileField
									label="Joriy holat"
									icon={<SyncOutlined />}
									value={<OperatorStatusTag status={profile.operator.currentStatus} />}
								/>
								<ProfileField
									label="Holat o'zgargan vaqt"
									icon={<ClockCircleOutlined />}
									value={formatDateTime(profile.operator.lastStatusChange)}
									emptyText="Ma'lumot yo'q"
								/>
								<ProfileField
									label="Profil yaratilgan"
									icon={<CalendarOutlined />}
									value={formatDateTime(profile.operator.createdAt)}
								/>
							</>
						) : (
							<Empty
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={
									<div className="text-center">
										<div className="font-bold text-slate-500">Sizda operator profili yo'q</div>
										<div className="mt-1 text-xs text-slate-400">
											Ichki raqam berilishi uchun nazoratchi bilan bog'laning
										</div>
									</div>
								}
							/>
						)}
					</Card>

					<ChangePasswordCard />
				</div>
			)}
		</div>
	);
}
