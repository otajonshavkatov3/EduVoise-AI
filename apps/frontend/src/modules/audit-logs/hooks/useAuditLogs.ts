import { useQuery } from "@tanstack/react-query";
import { auditService } from "../services/audit.service";
import type { AuditFilters } from "../types";

export function useAuditLogs(filters: AuditFilters) {
	return useQuery({
		queryKey: ["audit-logs", "list", filters],
		queryFn: () => auditService.list(filters),
	});
}
