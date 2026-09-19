/**
 * Tenant isolation.
 *
 *   scope.ts            what every query site uses: tenantScope(c), tenantWhere().
 *   store.ts            reading a tenant row, cached; the transitional sole-tenant
 *                       seam the voice layer still leans on.
 *   tables.ts           which tables are tenant-owned, checked by a test.
 *   public.ts           the only tenant shape HTTP may return (no secrets).
 *   asterisk-naming.ts  how a tenant's endpoints and contexts are named.
 *   audit-vendor.ts     the trace a vendor cannot avoid leaving.
 *
 * The branded TenantId itself lives in shared/types/tenant.ts, because the schema
 * declares its columns with it and the frontend will eventually need the type too.
 */
export { asTenantId, isTenantId, type TenantId } from "@shared/types";
export {
	endpointAuthName,
	endpointName,
	LEGACY_CONTEXTS,
	queueName,
	slugFromContext,
	slugFromEndpointName,
	tenantContexts,
	trunkEndpointName,
	trunkSectionNames,
	webExtensionFor,
} from "./asterisk-naming";
export { auditVendorAccess, auditVendorEnter } from "./audit-vendor";
export {
	tenantIdOfCall,
	tenantIdOfContact,
	tenantIdOfParent,
	tenantIdOfTicket,
} from "./derive";
export {
	type PublicTenant,
	TENANT_SECRET_COLUMNS,
	type TenantSecretColumn,
	toPublicTenant,
} from "./public";
export {
	currentTenantId,
	isVendorRole,
	requireTenantRow,
	requireVendor,
	type TenantActor,
	type TenantScope,
	tenantScope,
	tenantWhere,
} from "./scope";
export {
	getSoleTenantId,
	getTenantById,
	getTenantBySlug,
	getVendorTenantId,
	invalidateTenantCache,
	isTenantOperational,
	listAllTenants,
	soleTenantIdOrNull,
} from "./store";
export {
	allSchemaTables,
	GLOBAL_TABLE_NAMES,
	isTenantScopedTable,
	type TenantScopedTable,
	tableName,
} from "./tables";
export { generateWebhookToken } from "./webhook-token";
