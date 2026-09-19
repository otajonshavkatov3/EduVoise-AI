import apiClient from "@/app/api/client";
import type {
	DashboardCallVolume,
	DashboardMissedCalls,
	DashboardOverview,
	DashboardPeriod,
} from "../types";

/** Endpointlar app/api/endpoint.ts da yo'q — bu modul o'z yo'llarini o'zi biladi. */
const DASHBOARD_PATHS = {
	overview: "/dashboard/overview",
	callVolume: "/dashboard/call-volume",
	missedCalls: "/dashboard/missed-calls",
} as const;

interface Envelope<T> {
	success: true;
	data: T;
}

export const dashboardService = {
	async getOverview(period: DashboardPeriod): Promise<DashboardOverview> {
		const res = await apiClient.get<Envelope<DashboardOverview>>(DASHBOARD_PATHS.overview, {
			params: { period },
		});
		return res.data.data;
	},

	async getCallVolume(period: DashboardPeriod): Promise<DashboardCallVolume> {
		const res = await apiClient.get<Envelope<DashboardCallVolume>>(DASHBOARD_PATHS.callVolume, {
			params: { period },
		});
		return res.data.data;
	},

	async getMissedCalls(period: DashboardPeriod, limit = 10): Promise<DashboardMissedCalls> {
		const res = await apiClient.get<Envelope<DashboardMissedCalls>>(DASHBOARD_PATHS.missedCalls, {
			params: { period, limit },
		});
		return res.data.data;
	},
};
