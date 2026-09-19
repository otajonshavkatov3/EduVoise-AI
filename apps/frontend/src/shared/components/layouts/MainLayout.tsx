import {
	AuditOutlined,
	BarChartOutlined,
	CalendarOutlined,
	CheckSquareOutlined,
	ContactsOutlined,
	CustomerServiceOutlined,
	DashboardOutlined,
	DollarOutlined,
	ExclamationCircleOutlined,
	LogoutOutlined,
	MenuFoldOutlined,
	MenuUnfoldOutlined,
	NotificationOutlined,
	PhoneOutlined,
	SettingOutlined,
	TagsOutlined,
	TeamOutlined,
	UserOutlined,
} from "@ant-design/icons";
import type { UserRoleType } from "@shared/types";
import { Avatar, Button, Dropdown, Layout, Menu, Tooltip } from "antd";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useLogout } from "@/modules/auth/hooks/useAuth";
import { useAuthStore } from "@/modules/auth/store/auth.store";
import { CallPopModal } from "@/modules/calls/components/CallPopModal";
import { DialpadModal } from "@/modules/calls/components/DialpadModal";
import { handleLiveCallWsMessage } from "@/modules/calls/live/store/liveCalls.store";
import { SipPhoneProvider } from "@/modules/calls/providers/SipPhoneProvider";
import { useCallPopStore } from "@/modules/calls/store/callPop.store";
import { handleCallPopWsMessage } from "@/modules/calls/store/callPopWs";
import { OperatorStatusSwitcher } from "@/modules/operators/components/OperatorStatusSwitcher";
import { useWebSocket, type WsMessage } from "@/shared/hooks/useWebSocket";
import { useWsStore } from "@/shared/store/ws.store";
import { roleLabel, WS_STATUS_LABELS } from "@/shared/utils/labels";

const { Header, Sider, Content } = Layout;

/**
 * House rule: when the backend gates a whole page by role, the sidebar carries
 * the same list. A link whose page can only answer 403 is not a menu item.
 *
 * The page keeps its own guard for anyone who types the URL - /users and
 * /audit-logs bounce via ProtectedRoute, /reports and /ai-costs render a card
 * that says why. The guard is what makes this safe; the filter is what stops the
 * menu from advertising four pages a manager cannot open.
 *
 * All four are supervisor+admin on the backend: /api/users, /api/audit-logs,
 * /api/reports/* and /api/ai-costs/*.
 */
const SUPERVISOR_ONLY: UserRoleType[] = ["supervisor", "admin"];

/** Rol ro'yxati berilmagan punkt hammaga ko'rinadi. */
const menuItems: { key: string; icon: ReactNode; label: string; roles?: UserRoleType[] }[] = [
	{
		key: "/dashboard",
		icon: <DashboardOutlined />,
		label: "Asosiy oyna",
	},
	{
		key: "/calls",
		icon: <PhoneOutlined />,
		label: "Qo'ng'iroqlar",
	},
	{
		key: "/missed-calls",
		icon: <ExclamationCircleOutlined />,
		label: "Javobsiz qo'ng'iroqlar",
	},
	{
		/*
		 * One entry, not two. The do-not-call list lives as a tab on this page
		 * rather than as its own item: it is only ever read in the context of "who
		 * are we ringing", and a second entry would put a list of four numbers at
		 * the same level as the whole outbound workflow.
		 *
		 * No `roles` filter, because the backend does not gate GET /campaigns
		 * either - a manager may read what is being called and how it went. The
		 * page hides the create/start/pause controls for them, the same list the
		 * backend enforces (supervisor + admin).
		 */
		key: "/campaigns",
		icon: <NotificationOutlined />,
		label: "Chiquvchi kampaniyalar",
	},
	{
		key: "/contacts",
		icon: <ContactsOutlined />,
		label: "Kontaktlar",
	},
	{
		key: "/tickets",
		icon: <TagsOutlined />,
		label: "Murojaatlar",
	},
	{
		key: "/follow-ups",
		icon: <CheckSquareOutlined />,
		label: "Keyingi aloqa vazifalari",
	},
	{
		key: "/bookings",
		icon: <CalendarOutlined />,
		label: "Uchrashuvlar",
	},
	{
		key: "/ai-assistant",
		icon: <CustomerServiceOutlined />,
		label: "AI yordamchi",
	},
	{
		key: "/ai-costs",
		icon: <DollarOutlined />,
		label: "AI xarajatlari",
		roles: SUPERVISOR_ONLY,
	},
	{
		key: "/reports",
		icon: <BarChartOutlined />,
		label: "Hisobotlar",
		roles: SUPERVISOR_ONLY,
	},
	{
		key: "/operators",
		icon: <TeamOutlined />,
		label: "Operatorlar",
	},
	{
		key: "/users",
		icon: <UserOutlined />,
		label: "Foydalanuvchilar",
		roles: SUPERVISOR_ONLY,
	},
	{
		key: "/audit-logs",
		icon: <AuditOutlined />,
		label: "Audit jurnallari",
		roles: SUPERVISOR_ONLY,
	},
	{
		key: "/settings",
		icon: <SettingOutlined />,
		label: "Sozlamalar",
	},
];

/**
 * The section name in the header.
 *
 * Matched by prefix, not exactly: a child route inherits its parent's name. With
 * exact matching every detail page - and /calls/:id is now the one opened most
 * often in the product - showed the placeholder "Sahifa" instead of a name. The
 * longest match wins so a nested section cannot be shadowed by a shorter one.
 */
function currentSectionLabel(pathname: string): string {
	const matches = menuItems.filter(
		(item) => pathname === item.key || pathname.startsWith(`${item.key}/`)
	);

	if (matches.length === 0) {
		return "Sahifa";
	}

	return matches.reduce((best, item) => (item.key.length > best.key.length ? item : best)).label;
}

export function MainLayout() {
	const [collapsed, setCollapsed] = useState(false);
	const [isDialpadOpen, setIsDialpadOpen] = useState(false);
	const navigate = useNavigate();
	const location = useLocation();
	const user = useAuthStore((state) => state.user);
	const { mutate: logout, isPending: isLoggingOut } = useLogout();
	const visible = useCallPopStore((state) => state.visible);
	const { status: wsStatus, setStatus: setWsStatus } = useWsStore();

	const visibleMenuItems = useMemo(
		() =>
			menuItems
				.filter((item) => !item.roles || (user !== null && item.roles.includes(user.role)))
				.map(({ roles: _roles, ...item }) => item),
		[user]
	);

	// Close dialpad when a call pop modal opens
	useEffect(() => {
		if (visible) {
			setIsDialpadOpen(false);
		}
	}, [visible]);

	// Soket faqat serverdan mijozga: `useWebSocket` avval `sendMessage` ni ham
	// qaytarardi, u store'ga yozilardi va hech bir komponent uni o'qimasdi.
	useWebSocket({
		enabled: !!user,
		onStatusChange: (status) => setWsStatus(status),
		onMessage: (msg: WsMessage) => {
			// Additive: AI voice / live-call hodisalarini jonli qo'ng'iroqlar doskasiga
			// uzatadi. Tanish bo'lmagan turlar u yerda e'tiborsiz qoldiriladi, shuning
			// uchun quyidagi mavjud ishlov berish o'zgarmaydi.
			handleLiveCallWsMessage(msg);

			// Panelning server hodisalari (`incoming_call`, `call_ended`,
			// `live_call_ended`) — moslik va xavfsizlik shartlari bilan birga
			// `callPopWs` ichida.
			handleCallPopWsMessage(msg);
		},
	});

	useEffect(() => {
		return () => {
			setWsStatus("disconnected");
		};
	}, [setWsStatus]);

	const userMenuItems = [
		{
			key: "profile",
			icon: <UserOutlined />,
			label: "Profil",
		},
		{
			type: "divider" as const,
		},
		{
			key: "logout",
			icon: <LogoutOutlined />,
			label: "Chiqish",
			danger: true,
		},
	];

	const handleUserMenuClick = ({ key }: { key: string }) => {
		if (key === "logout") {
			logout();
		} else if (key === "profile") {
			navigate("/profile");
		}
	};

	const handleMenuClick = ({ key }: { key: string }) => {
		navigate(key);
	};

	return (
		<SipPhoneProvider>
			<Layout className="min-h-screen bg-[#F8FAFC]">
				<Sider
					trigger={null}
					collapsible
					collapsed={collapsed}
					theme="dark"
					width={280}
					className="shadow-xl app-sider"
					style={{
						background: "linear-gradient(180deg, #1D2026 0%, #111827 100%)",
						position: "fixed",
						height: "100vh",
						left: 0,
						zIndex: 100,
					}}
				>
					<div className="h-20 flex items-center justify-center mb-4 px-4 overflow-hidden mt-2 shrink-0">
						{collapsed ? (
							<div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30">
								<svg
									width="24"
									height="24"
									viewBox="0 0 24 24"
									fill="none"
									stroke="white"
									strokeWidth="2.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<title>Call Center logotipi</title>
									<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l2.27-2.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
								</svg>
							</div>
						) : (
							<div className="flex items-center gap-3 w-full">
								<div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30 shrink-0">
									<svg
										width="24"
										height="24"
										viewBox="0 0 24 24"
										fill="none"
										stroke="white"
										strokeWidth="2.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<title>Call Center logotipi</title>
										<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l2.27-2.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
									</svg>
								</div>
								<div className="overflow-hidden">
									<div className="text-white font-bold text-lg leading-tight truncate">
										Call Center
									</div>
									<div className="text-blue-400 text-xs font-medium">Boshqaruv paneli</div>
								</div>
							</div>
						)}
					</div>
					{/* Scrollable nav region. flex-1 + min-h-0 is what actually lets it
					    shrink and scroll - without min-h-0 a flex child refuses to go
					    below its content height and the overflow is clipped instead. */}
					<div className="flex-1 min-h-0 sidebar-scroll">
						<Menu
							theme="dark"
							mode="inline"
							selectedKeys={[location.pathname]}
							items={visibleMenuItems}
							onClick={handleMenuClick}
							className="border-none custom-menu"
							style={{ background: "transparent", fontSize: 15 }}
						/>
					</div>
					{/* Pinned below the scroll area instead of absolutely positioned, so
					    it can never overlap the last menu item. */}
					<div className="shrink-0 px-6 py-5 border-t border-white/10">
						<Button
							type="text"
							onClick={() => logout()}
							loading={isLoggingOut}
							icon={<LogoutOutlined />}
							className={`w-full h-12 flex items-center justify-center gap-3 rounded-2xl border border-white/10 backdrop-blur-md font-bold transition-all hover:bg-red-500/10 hover:border-red-500/30 text-white/70 hover:text-red-400 ${collapsed ? "px-0" : ""}`}
						>
							{!collapsed && "Tizimdan chiqish"}
						</Button>
					</div>
				</Sider>
				<Layout style={{ marginLeft: collapsed ? 80 : 280, transition: "all 0.2s" }}>
					<Header
						className="px-8 flex items-center justify-between sticky top-0 z-50 transition-all duration-300"
						style={{
							background: "rgba(255, 255, 255, 0.8)",
							backdropFilter: "blur(8px)",
							borderBottom: "1px solid #E2E8F0",
							height: 72,
						}}
					>
						<Button
							type="text"
							icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
							onClick={() => setCollapsed(!collapsed)}
							className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-50 hover:bg-gray-100! text-gray-600 transition-all"
						/>

						<div className="flex-1 px-8 hidden md:block">
							<div className="text-gray-400 text-xs font-semibold uppercase tracking-widest leading-none mb-1">
								Joriy bo'lim
							</div>
							<div className="text-gray-900 font-bold capitalize text-lg leading-none">
								{currentSectionLabel(location.pathname)}
							</div>
						</div>

						<div className="flex items-center gap-4">
							<OperatorStatusSwitcher />
							<Dropdown
								menu={{
									items: userMenuItems,
									onClick: handleUserMenuClick,
								}}
								placement="bottomRight"
								trigger={["click"]}
								disabled={isLoggingOut}
							>
								<div className="flex items-center gap-4 bg-gray-50 hover:bg-gray-100 px-4 py-2 rounded-2xl cursor-pointer transition-all border border-gray-100">
									<div className="flex items-center gap-3">
										<Tooltip title={`Jonli kanal: ${WS_STATUS_LABELS[wsStatus]}`}>
											<div
												className={`w-2.5 h-2.5 rounded-full shadow-sm transition-colors ${
													wsStatus === "connected"
														? "bg-emerald-500 animate-pulse"
														: wsStatus === "connecting"
															? "bg-amber-400 animate-bounce"
															: "bg-rose-500"
												}`}
											/>
										</Tooltip>
										<div className="text-right hidden sm:block">
											<div className="text-gray-900 font-bold text-sm leading-none mb-1">
												{user?.phone}
											</div>
											<div className="text-blue-600 font-medium text-[10px] uppercase tracking-wider leading-none">
												{user ? roleLabel(user.role) : ""}
											</div>
										</div>
									</div>
									<Avatar
										size={40}
										icon={<UserOutlined />}
										className="bg-blue-100 text-blue-600 border-2 border-white shadow-sm"
									/>
								</div>
							</Dropdown>
						</div>
					</Header>
					<Content className="p-8">
						<div
							className="max-w-[1600px] mx-auto min-h-[calc(100vh-144px)] animate-fadeIn"
							key={location.pathname}
						>
							<Outlet />
						</div>
					</Content>
				</Layout>
				<div className="fixed bottom-8 right-8 z-1001">
					<Button
						type="primary"
						shape="circle"
						size="large"
						icon={<PhoneOutlined className="text-2xl" />}
						onClick={() => setIsDialpadOpen(true)}
						className="w-16 h-16 shadow-2xl shadow-blue-500/40 bg-blue-600 hover:scale-110 transition-transform flex items-center justify-center border-none"
					/>
				</div>
				<CallPopModal />
				<DialpadModal open={isDialpadOpen} onClose={() => setIsDialpadOpen(false)} />
			</Layout>
		</SipPhoneProvider>
	);
}
