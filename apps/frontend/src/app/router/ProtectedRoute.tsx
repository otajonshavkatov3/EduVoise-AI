import type { UserRoleType } from "@shared/types";
import { Spin } from "antd";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/modules/auth/store/auth.store";

interface ProtectedRouteProps {
	children: ReactNode;
	allowedRoles?: UserRoleType[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
	const location = useLocation();
	const { isAuthenticated, isLoading, user } = useAuthStore();

	// Show loading spinner while checking auth state
	if (isLoading) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<Spin size="large" />
			</div>
		);
	}

	// Not authenticated - redirect to login
	if (!isAuthenticated) {
		return <Navigate to="/login" state={{ from: location }} replace />;
	}

	// Check role-based access
	if (allowedRoles && user && !allowedRoles.includes(user.role)) {
		return <Navigate to="/dashboard" replace />;
	}

	return <>{children}</>;
}
