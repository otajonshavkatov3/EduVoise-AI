/**
 * The tenant identifier, as a type the compiler will not let you get wrong.
 *
 * WHY A BRAND AND NOT `string`. Tenant isolation is enforced by 148 query sites,
 * each of which has to put the right uuid in the right place. Every id in this
 * system is a uuid string, so `eq(calls.tenantId, userId)` - a real mistake,
 * easily made while rewriting a query in a hurry - type-checks perfectly if
 * TenantId is just `string`. It compiles, it runs, it returns zero rows in
 * development (where userId is nobody's tenant) and it is a cross-tenant read the
 * day some uuid happens to collide with a tenant id. With the brand it does not
 * compile at all.
 *
 * The brand is applied at the schema (`tenant_id` columns are declared
 * `$type<TenantId>()`), so a tenant id read out of a row is already branded and
 * flows through the code with no ceremony. `asTenantId()` is needed only at the
 * boundaries where a tenant id arrives as raw text: a JWT claim, a URL parameter,
 * an environment variable.
 *
 * It is a type-level device only: at runtime a TenantId is exactly the string it
 * always was, so it serialises, logs and compares as normal.
 */

declare const tenantIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: "TenantId" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for anything shaped like the uuid a tenant id is. */
export function isTenantId(value: unknown): value is TenantId {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Brand a raw string as a tenant id, rejecting anything that is not a uuid.
 *
 * Throws rather than returning null: every caller is a trust boundary (token
 * claim, path parameter, seed script argument) and a caller that could not
 * produce a tenant id must not continue with a tenant-shaped value it invented.
 * The message deliberately does not include the value - it can come from an
 * untrusted request and this string reaches the logs.
 */
export function asTenantId(value: string): TenantId {
	if (!isTenantId(value)) {
		throw new Error("Invalid tenant id: expected a uuid");
	}

	return value;
}
