import { between, count, sql } from "drizzle-orm";

import { db } from "@/db";
import { calls } from "@/db/schema";
import { currentTenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";

import {
	callsFilter,
	type DashboardScope,
	loadAiCategories,
	loadCallStats,
	loadCallVolume,
	loadOperatorStatuses,
	loadOperatorWorkload,
	loadSentiment,
	loadTicketCategories,
	loadUnansweredCalls,
	resolveDashboardScope,
	resolvePeriodRange,
} from "./dashboard.metrics";
import type * as r from "./dashboard.routes";
import type { MissedCallsQuery, PeriodQuery } from "./dashboard.schemas";

/** Javobda operator profili yo'qligini oshkor qiladi — UI "0" ni izohlashi uchun. */
function toScopePayload(scope: DashboardScope) {
	return {
		operatorScoped: scope.operatorScoped,
		hasOperatorProfile: !scope.operatorScoped || scope.operatorId !== null,
	};
}

/**
 * MAVJUD endpoint. Javob shakli bir xilda qoldirildi (boshqa kod o'qiydi):
 * answeredCalls faqat status='answered', avgDurationSec barcha qatorlar bo'yicha.
 * Aniqroq ko'rsatkichlar /overview'da.
 */
export const summaryHandler: AppRouteHandler<typeof r.summary> = async (c) => {
	const tenantId = currentTenantId(c);
	const now = new Date();
	const startOfDay = new Date(now);
	startOfDay.setHours(0, 0, 0, 0);
	const endOfDay = new Date(now);
	endOfDay.setHours(23, 59, 59, 999);

	const [data] =
		(await db
			.select({
				totalCalls: count().as("total"),
				inboundCalls: sql<number>`COUNT(*) FILTER (WHERE ${calls.direction} = 'inbound')`,
				outboundCalls: sql<number>`COUNT(*) FILTER (WHERE ${calls.direction} = 'outbound')`,
				answeredCalls: sql<number>`COUNT(*) FILTER (WHERE ${calls.status} = 'answered')`,
				missedCalls: sql<number>`COUNT(*) FILTER (WHERE ${calls.status} = 'missed')`,
				avgDurationSec: sql<number>`COALESCE(AVG(${calls.duration}), 0)`,
			})
			.from(calls)
			// "Bugungi qo'ng'iroqlar" — faqat shu mijozning qo'ng'iroqlari. Applied here
			// rather than in a variable above so the tenant is visible at the query itself.
			.where(tenantWhere(calls, tenantId, between(calls.startedAt, startOfDay, endOfDay)))) ?? [];

	const safeData = data ?? {
		totalCalls: 0,
		inboundCalls: 0,
		outboundCalls: 0,
		answeredCalls: 0,
		missedCalls: 0,
		avgDurationSec: 0,
	};

	return c.json(
		{
			success: true as const,
			data: {
				totalCalls: Number(safeData.totalCalls ?? 0),
				inboundCalls: Number(safeData.inboundCalls ?? 0),
				outboundCalls: Number(safeData.outboundCalls ?? 0),
				answeredCalls: Number(safeData.answeredCalls ?? 0),
				missedCalls: Number(safeData.missedCalls ?? 0),
				avgDurationSec: Math.round(Number(safeData.avgDurationSec ?? 0)),
			},
		},
		200
	);
};

export const overviewHandler: AppRouteHandler<typeof r.overview> = async (c) => {
	const user = c.get("user");
	const { period } = c.req.valid("query") as PeriodQuery;

	const range = resolvePeriodRange(period);
	const scope = await resolveDashboardScope(user);

	const currentFilter = callsFilter(range.from, range.to, scope);
	const previousFilter = callsFilter(range.previousFrom, range.previousTo, scope);

	const [
		current,
		previous,
		operators,
		operatorWorkload,
		sentiment,
		ticketCategories,
		aiCategories,
	] = await Promise.all([
		loadCallStats(currentFilter),
		loadCallStats(previousFilter),
		loadOperatorStatuses(scope),
		loadOperatorWorkload(currentFilter),
		loadSentiment(currentFilter),
		loadTicketCategories(range.from, range.to, scope),
		loadAiCategories(currentFilter),
	]);

	return c.json(
		{
			success: true as const,
			data: {
				period: range.period,
				range: { from: range.from.toISOString(), to: range.to.toISOString() },
				previousRange: {
					from: range.previousFrom.toISOString(),
					to: range.previousTo.toISOString(),
				},
				scope: toScopePayload(scope),
				current,
				previous,
				operators,
				operatorWorkload,
				sentiment,
				ticketCategories,
				aiCategories,
			},
		},
		200
	);
};

export const callVolumeHandler: AppRouteHandler<typeof r.callVolume> = async (c) => {
	const user = c.get("user");
	const { period } = c.req.valid("query") as PeriodQuery;

	const range = resolvePeriodRange(period);
	const scope = await resolveDashboardScope(user);
	const filter = callsFilter(range.from, range.to, scope);

	const buckets = await loadCallVolume(range, filter);
	const totalCalls = buckets.reduce((sum, bucket) => sum + bucket.total, 0);

	return c.json(
		{
			success: true as const,
			data: {
				period: range.period,
				granularity: range.granularity,
				range: { from: range.from.toISOString(), to: range.to.toISOString() },
				scope: toScopePayload(scope),
				buckets,
				totalCalls,
			},
		},
		200
	);
};

export const missedCallsHandler: AppRouteHandler<typeof r.missedCalls> = async (c) => {
	const user = c.get("user");
	const { period, limit } = c.req.valid("query") as MissedCallsQuery;

	const range = resolvePeriodRange(period);
	const scope = await resolveDashboardScope(user);
	const filter = callsFilter(range.from, range.to, scope);

	const { items, total } = await loadUnansweredCalls(filter, limit);

	return c.json(
		{
			success: true as const,
			data: {
				period: range.period,
				range: { from: range.from.toISOString(), to: range.to.toISOString() },
				scope: toScopePayload(scope),
				items,
				total,
			},
		},
		200
	);
};
