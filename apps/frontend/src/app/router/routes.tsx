import type { UserRoleType } from "@shared/types";
import { Navigate, type RouteObject, useParams } from "react-router-dom";
import AiAssistantPage from "@/modules/ai-assistant/pages/AiAssistantPage";
import AiSessionDetailPage from "@/modules/ai-assistant/pages/AiSessionDetailPage";
import AiCostsPage from "@/modules/ai-costs/pages/AiCostsPage";
import AuditLogsPage from "@/modules/audit-logs/pages/AuditLogsPage";
import { LoginPage } from "@/modules/auth/pages/LoginPage";
import BookingsPage from "@/modules/bookings/pages/BookingsPage";
import CallDetailPage from "@/modules/calls/pages/CallDetailPage";
import CallHistoryPage from "@/modules/calls/pages/CallHistoryPage";
import MissedCallsPage from "@/modules/calls/pages/MissedCallsPage";
import CampaignDetailPage from "@/modules/campaigns/pages/CampaignDetailPage";
import CampaignsPage from "@/modules/campaigns/pages/CampaignsPage";
import ContactDetailPage from "@/modules/contacts/pages/ContactDetailPage";
import ContactsPage from "@/modules/contacts/pages/ContactsPage";
import DashboardPage from "@/modules/dashboard/pages/DashboardPage";
import FollowUpsPage from "@/modules/follow-ups/pages/FollowUpsPage";
import OperatorsPage from "@/modules/operators/pages/OperatorsPage";
import ProfilePage from "@/modules/profile/pages/ProfilePage";
import ReportsPage from "@/modules/reports/pages/ReportsPage";
import SettingsPage from "@/modules/settings/pages/SettingsPage";
import TicketDetailPage from "@/modules/tickets/pages/TicketDetailPage";
import TicketsPage from "@/modules/tickets/pages/TicketsPage";
import UsersPage from "@/modules/users/pages/UsersPage";
import { AuthLayout } from "@/shared/components/layouts/AuthLayout";
import { MainLayout } from "@/shared/components/layouts/MainLayout";
import { ProtectedRoute } from "./ProtectedRoute";

/** Backenddagi SUPERVISOR_ONLY / AUDIT_VIEW_ROLES bilan bir xil ro'yxat. */
const SUPERVISOR_ONLY: UserRoleType[] = ["supervisor", "admin"];

/** Eski `/transcripts/:callId` — o'sha qo'ng'iroq kartasi. */
function LegacyCallRedirect() {
	const { callId } = useParams();

	return <Navigate to={callId ? `/calls/${callId}` : "/calls"} replace />;
}

export const routes: RouteObject[] = [
	// Public routes - Auth
	{
		path: "/login",
		element: <AuthLayout />,
		children: [
			{
				index: true,
				element: <LoginPage />,
			},
		],
	},

	// Protected routes
	{
		path: "/",
		element: (
			<ProtectedRoute>
				<MainLayout />
			</ProtectedRoute>
		),
		children: [
			{
				index: true,
				element: <Navigate to="/dashboard" replace />,
			},
			{
				path: "dashboard",
				element: <DashboardPage />,
			},
			{
				path: "calls",
				element: <CallHistoryPage />,
			},
			{
				path: "calls/:id",
				element: <CallDetailPage />,
			},
			{
				path: "call-history",
				element: <Navigate to="/calls" replace />,
			},
			{
				path: "missed-calls",
				element: <MissedCallsPage />,
			},
			/*
			 * Jonli qo'ng'iroqlar, yozuvlar, transkriptlar va AI tahlili endi
			 * /calls ichida: jonli qatorlar ro'yxatning tepasidagi bo'limda,
			 * qolgani esa /calls/:id kartasida. Eski manzillar yo'qolmadi —
			 * saqlab qo'yilgan havola va xatcho'plar shu yerga tushadi.
			 */
			{
				path: "live-calls",
				element: <Navigate to="/calls" replace />,
			},
			{
				path: "recordings",
				element: <Navigate to="/calls" replace />,
			},
			{
				path: "transcripts",
				element: <Navigate to="/calls" replace />,
			},
			{
				path: "transcripts/:callId",
				element: <LegacyCallRedirect />,
			},
			{
				path: "ai-analysis",
				element: <Navigate to="/calls" replace />,
			},
			/*
			 * Chiquvchi kampaniyalar. Ro'yxatni ko'rish barcha rollarga ochiq
			 * (backend GET /campaigns ham shunday); yaratish va ishga tushirish
			 * sahifaning o'zida nazoratchi/administrator bilan cheklangan, chunki
			 * bu /ai-costs dagi pulni sarflaydi.
			 */
			{
				path: "campaigns",
				element: <CampaignsPage />,
			},
			{
				path: "campaigns/:id",
				element: <CampaignDetailPage />,
			},
			{
				path: "contacts",
				element: <ContactsPage />,
			},
			{
				path: "contacts/:id",
				element: <ContactDetailPage />,
			},
			{
				path: "tickets",
				element: <TicketsPage />,
			},
			{
				path: "tickets/:id",
				element: <TicketDetailPage />,
			},
			{
				path: "follow-ups",
				element: <FollowUpsPage />,
			},
			{
				path: "bookings",
				element: <BookingsPage />,
			},
			{
				path: "ai-assistant",
				element: <AiAssistantPage />,
			},
			{
				path: "ai-assistant/sessions/:id",
				element: <AiSessionDetailPage />,
			},
			{
				path: "ai-costs",
				element: <AiCostsPage />,
			},
			{
				path: "reports",
				element: <ReportsPage />,
			},
			{
				path: "operators",
				element: <OperatorsPage />,
			},
			{
				// Backend GET /users va GET /audit-logs ni supervisor+admin bilan
				// cheklaydi, shuning uchun manager bu sahifalarni ochsa faqat 403
				// ko'rardi. ProtectedRoute allaqachon shu ishni qila olardi —
				// unga hech qachon rol berilmagan edi.
				path: "users",
				element: (
					<ProtectedRoute allowedRoles={SUPERVISOR_ONLY}>
						<UsersPage />
					</ProtectedRoute>
				),
			},
			{
				path: "settings",
				element: <SettingsPage />,
			},
			{
				// The header's user menu has always navigated here; without this route
				// react-router fell through to the "*" catch-all and silently bounced
				// the user back to the dashboard.
				path: "profile",
				element: <ProfilePage />,
			},
			{
				path: "audit-logs",
				element: (
					<ProtectedRoute allowedRoles={SUPERVISOR_ONLY}>
						<AuditLogsPage />
					</ProtectedRoute>
				),
			},
		],
	},

	// 404 - Redirect to dashboard or login
	{
		path: "*",
		element: <Navigate to="/" replace />,
	},
];
