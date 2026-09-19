import { Alert, Button } from "antd";
import type { DashboardScope } from "../types";

interface DashboardNoticesProps {
	scope?: DashboardScope;
	errorMessage: string | null;
	onRetry: () => void;
}

/** Xato va RBAC ogohlantirishlari — bo'sh raqamlar sababi yashirilmasligi uchun. */
export function DashboardNotices({ scope, errorMessage, onRetry }: DashboardNoticesProps) {
	const scopedWithProfile = scope?.operatorScoped === true && scope.hasOperatorProfile;
	const scopedWithoutProfile = scope?.operatorScoped === true && !scope.hasOperatorProfile;

	return (
		<>
			{errorMessage && (
				<Alert
					type="error"
					showIcon
					className="mb-6 rounded-2xl"
					message="Ma'lumotlarni yuklab bo'lmadi"
					description={errorMessage}
					action={
						<Button size="small" onClick={onRetry}>
							Qayta urinish
						</Button>
					}
				/>
			)}

			{scopedWithProfile && (
				<Alert
					type="info"
					showIcon
					className="mb-6 rounded-2xl"
					message="Faqat sizga tegishli ko'rsatkichlar"
					description="Menejer sifatida siz o'zingizga biriktirilgan qo'ng'iroqlar va o'zingiz yaratgan murojaatlar raqamlarini ko'rasiz."
				/>
			)}

			{scopedWithoutProfile && (
				<Alert
					type="warning"
					showIcon
					className="mb-6 rounded-2xl"
					message="Sizga operator profili biriktirilmagan"
					description="Shu sababli qo'ng'iroq ko'rsatkichlari bo'sh. Profil biriktirilgandan keyin raqamlar avtomatik to'ldiriladi."
				/>
			)}
		</>
	);
}
