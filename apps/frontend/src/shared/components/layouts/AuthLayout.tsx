import { Layout } from "antd";
import { Navigate, Outlet } from "react-router-dom";
import loginBg from "@/assets/login-bg.png";
import { useAuthStore } from "@/modules/auth/store/auth.store";

const { Content } = Layout;

export function AuthLayout() {
	const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

	if (isAuthenticated) {
		return <Navigate to="/dashboard" replace />;
	}

	return (
		<Layout className="min-h-screen flex flex-row overflow-hidden bg-white">
			{/* Left side: branding and illustration */}
			<div className="hidden lg:flex lg:w-3/5 relative items-center justify-center p-16">
				<div
					className="absolute inset-0 z-0 bg-blue-600"
					style={{
						backgroundImage: `linear-gradient(rgba(33, 84, 178, 0.8), rgba(33, 84, 178, 0.9)), url(${loginBg})`,
						backgroundSize: "cover",
						backgroundPosition: "center",
					}}
				/>
				<div className="relative z-10 text-white max-w-xl">
					<div className="mb-12">
						<div className="w-16 h-16 bg-white/20 rounded-2xl backdrop-blur-md flex items-center justify-center mb-6">
							<svg
								width="40"
								height="40"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="text-white"
							>
								<title>Call Center Pro logotipi</title>
								<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l2.27-2.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
							</svg>
						</div>
						<h1 className="text-5xl font-extrabold tracking-tight mb-4">
							Call Center <span className="text-blue-200">Pro</span>
						</h1>
						<p className="text-xl text-blue-100/90 leading-relaxed font-light">
							Qo'ng'iroq markazini yagona platformada boshqaring. Samaradorlikni kuzating,
							murojaatlarni nazorat qiling va mijozlar mamnuniyatini oshiring.
						</p>
					</div>

					<div className="grid grid-cols-2 gap-8">
						<div>
							<h3 className="text-white font-bold text-lg mb-2">Jonli tahlil</h3>
							<p className="text-blue-100/70 text-sm">
								Qo'ng'iroqlar oqimi va operatorlar holatini real vaqtda kuzating.
							</p>
						</div>
						<div>
							<h3 className="text-white font-bold text-lg mb-2">Murojaatlarni boshqarish</h3>
							<p className="text-blue-100/70 text-sm">
								Mijoz murojaatlarini tartibga soling va muhimligini belgilang.
							</p>
						</div>
					</div>
				</div>

				{/* Glassmorphism accent */}
				<div className="absolute top-20 right-20 w-64 h-64 bg-white/10 rounded-full blur-3xl" />
				<div className="absolute bottom-20 left-20 w-48 h-48 bg-blue-400/20 rounded-full blur-3xl" />
			</div>

			{/* Right side: Login form */}
			<Content className="w-full lg:w-2/5 flex flex-col items-center justify-center p-8 lg:p-16 relative">
				<div className="w-full max-w-sm space-y-8">
					<div className="lg:hidden text-center mb-8">
						<h2 className="text-3xl font-bold text-blue-600">Call Center Pro</h2>
					</div>
					<Outlet />
				</div>

				<div className="mt-auto pt-8 text-gray-400 text-xs text-center">
					&copy; {new Date().getFullYear()} Call Center Pro. Barcha huquqlar himoyalangan.
				</div>
			</Content>
		</Layout>
	);
}
