import { useEffect, useMemo } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { sortLiveCallRows, useLiveCallsStore } from "../store/liveCalls.store";
import type { LiveCallRow } from "../types";
import { useLiveCallsQuery } from "./useLiveCalls";
import { useTicker } from "./useTicker";

interface LiveCallsBoard {
	rows: LiveCallRow[];
	activeRows: LiveCallRow[];
	/** Har sekundda yangilanadigan vaqt - davomiylikni hisoblash uchun. */
	nowMs: number;
	orchestratorRunning: boolean;
	scopedToOperator: boolean;
	lastEventAt: string | null;
	isLoading: boolean;
	isFetching: boolean;
	isError: boolean;
	errorMessage: string | null;
	refetch: () => void;
}

/**
 * REST snapshot'ini WebSocket orqali kelayotgan hodisalar bilan birlashtiradi.
 *
 * WS hodisalari `MainLayout`dagi mavjud ulanishdan `handleLiveCallWsMessage`
 * orqali store'ga tushadi; bu hook faqat store'ni o'qiydi va REST bilan
 * moslashtiradi.
 */
export function useLiveCallsBoard(): LiveCallsBoard {
	const query = useLiveCallsQuery();
	const hydrate = useLiveCallsStore((state) => state.hydrate);
	const prune = useLiveCallsStore((state) => state.prune);
	const calls = useLiveCallsStore((state) => state.calls);
	const orchestratorRunning = useLiveCallsStore((state) => state.orchestratorRunning);
	const scopedToOperator = useLiveCallsStore((state) => state.scopedToOperator);
	const lastEventAt = useLiveCallsStore((state) => state.lastEventAt);

	const nowMs = useTicker(1000);

	useEffect(() => {
		const payload = query.data?.data;
		if (!payload) {
			return;
		}
		hydrate({
			items: payload.items,
			orchestratorRunning: payload.orchestratorRunning,
			scopedToOperator: payload.scopedToOperator,
		});
	}, [query.data, hydrate]);

	// Tugagan qatorlarni saqlash muddati o'tgach doskadan olib tashlaydi.
	useEffect(() => {
		const timer = setInterval(() => prune(), 15_000);
		return () => clearInterval(timer);
	}, [prune]);

	const rows = useMemo(() => sortLiveCallRows(Object.values(calls)), [calls]);
	const activeRows = useMemo(() => rows.filter((row) => row.endedAtMs === null), [rows]);

	return {
		rows,
		activeRows,
		nowMs,
		orchestratorRunning,
		scopedToOperator,
		lastEventAt,
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		isError: query.isError,
		errorMessage: query.isError
			? getApiErrorMessage(query.error, "Jonli qo'ng'iroqlarni yuklab bo'lmadi")
			: null,
		refetch: () => {
			query.refetch();
		},
	};
}
