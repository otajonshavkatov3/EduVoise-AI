import {
	ExclamationCircleOutlined,
	LockOutlined,
	ReloadOutlined,
	RobotOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Skeleton } from "antd";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useActiveAgentProfile } from "../hooks/useAiAgent";
import { needsProfileSetup } from "../utils/profileForm";
import { AgentProfileForm } from "./AgentProfileForm";
import { ProfileSwitcherCard } from "./ProfileSwitcherCard";

/**
 * «Biznes profili» varag'i.
 *
 * Bu — mahsulotning o'zagi: biznes egasi shu yerda AI ni o'z biznesiga
 * moslashtiradi. Kodda hech qanday biznesga xos matn qolmagan, hammasi bazadan.
 */
export function AgentProfilePanel() {
	const user = useAuthStore((state) => state.user);
	const canEdit = user?.role === "supervisor";

	const profileQuery = useActiveAgentProfile();
	const profile = profileQuery.data?.data;

	if (profileQuery.isLoading) {
		return (
			<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
				<Skeleton active paragraph={{ rows: 8 }} />
			</Card>
		);
	}

	if (profileQuery.isError || !profile) {
		return (
			<Card className="overflow-hidden rounded-2xl border-none shadow-sm">
				<Alert
					type="error"
					showIcon
					className="rounded-xl border-rose-200 bg-rose-50"
					title={
						<span className="font-bold text-rose-600">
							{getApiErrorMessage(profileQuery.error, "Biznes profilini yuklab bo'lmadi")}
						</span>
					}
					description={
						<span className="text-slate-600">
							AI shu vaqt ichida ehtiyotkor standart sozlamalar bilan ishlaydi.
						</span>
					}
				/>
				<Button
					icon={<ReloadOutlined />}
					onClick={() => {
						profileQuery.refetch();
					}}
					className="mt-4 h-11 rounded-xl px-6 font-bold"
				>
					Qayta urinish
				</Button>
			</Card>
		);
	}

	// Faqat "qator bor-yo'qligi" emas, mazmuni ham qaraladi — aks holda backend
	// avtomatik yaratadigan standart profil tufayli ogohlantirish hech qachon
	// ko'rinmas edi (yoki aksincha, to'ldirilgan profilda ham osilib turardi).
	const needsSetup = needsProfileSetup(profile);

	return (
		<div className="space-y-6">
			{needsSetup && (
				<Alert
					type="warning"
					showIcon
					icon={<ExclamationCircleOutlined className="text-amber-500" />}
					className="rounded-2xl border-amber-200 bg-amber-50"
					title={
						<span className="font-bold text-amber-600">
							Biznes profili hali to'ldirilmagan — AI ehtiyotkor rejimda ishlaydi
						</span>
					}
					description={
						<div className="space-y-2 text-slate-600">
							<div>
								Hozir AI o'zini «{profile.businessName}» nomidan tanishtiradi, lekin biznesingiz
								haqidagi savollarga javob bermaydi: narx, manzil yoki ish vaqtini o'zidan to'qib
								aytishdan ko'ra, qo'ng'iroqni odamga uzatishni tanlaydi.
							</div>
							<div className="font-bold">
								Quyidagi shaklni to'ldiring va «Bilim bazasi» bo'limiga eng ko'p so'raladigan
								savollarni kiriting — shundan keyin AI biznesingiz nomidan javob bera boshlaydi.
							</div>
						</div>
					}
				/>
			)}

			{!needsSetup && (
				<div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-100 bg-white px-4 py-3 shadow-sm">
					<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
						<RobotOutlined />
					</div>
					<div className="min-w-0">
						<div className="text-sm font-black text-slate-900">{profile.businessName}</div>
						<div className="text-xs font-medium text-slate-500">
							{profile.industry?.trim()
								? profile.industry
								: "Yo'nalish ko'rsatilmagan — AI ohangi umumiy bo'ladi"}
						</div>
					</div>
					{!canEdit && (
						<div className="ml-auto flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-500">
							<LockOutlined />
							Faqat ko'rish rejimi
						</div>
					)}
				</div>
			)}

			{!canEdit && (
				<Alert
					type="info"
					showIcon
					className="rounded-2xl border-blue-100 bg-blue-50"
					title={
						<span className="font-bold text-blue-600">
							Profilni faqat nazoratchi o'zgartira oladi
						</span>
					}
					description={
						<span className="text-slate-600">
							Sozlamalar sizga ko'rish uchun ochiq, lekin saqlash imkoni yo'q.
						</span>
					}
				/>
			)}

			<ProfileSwitcherCard canEdit={canEdit} />

			{/*
			  Keyed on the profile id: activating a different profile must give a fresh
			  form, not the previous business's values re-labelled. Without the key the
			  sync signature is content-only, so switching profiles mid-edit carried the
			  old text across and would have saved it onto the new one.
			*/}
			<AgentProfileForm key={profile.id ?? "unconfigured"} profile={profile} canEdit={canEdit} />
		</div>
	);
}
