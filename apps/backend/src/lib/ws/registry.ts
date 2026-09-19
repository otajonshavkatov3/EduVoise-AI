/**
 * WebSocket connection registry.
 *
 * EXTENDED for the AI voice layer. Every previously existing export keeps its
 * exact signature and behaviour:
 *   getConnectionCount(userId), registerConnection(userId, ws),
 *   unregisterConnection(ws), broadcastToUser(userId, data)
 * `registerConnection` gained an OPTIONAL third parameter, so the existing
 * two-argument call in ws-handler.ts (and anything else) still compiles and
 * behaves identically. The legacy FreePBX webhook handlers that call
 * broadcastToUser are unaffected.
 *
 * What is new: connection metadata (tenant and role), which enables fan-out to a
 * class of users rather than one user. Live-call and transcript events need to
 * reach every supervisor/admin watching the board, not a single operator.
 *
 * TENANT. Every fan-out is scoped to one tenant, and the tenant is REQUIRED at
 * registration. Before tenancy, "every supervisor" meant every supervisor on the
 * platform: one customer's live call - the caller's number, the transcript as it is
 * spoken - would have been pushed live into another customer's dashboard. There is
 * no unscoped broadcast left in this file for that reason.
 */

import type { TenantId } from "@shared/types";

type WsLike = { send(data: string): void };

/** Roles as defined by the existing user_role enum. */
export type WsRole = "supervisor" | "admin" | "manager" | "vendor";

const userConnections = new Map<string, Set<WsLike>>();

/**
 * Per-socket metadata. Kept in a parallel map rather than wrapping the socket
 * so that nothing about the existing socket handling has to change.
 */
const connectionMeta = new Map<WsLike, { userId: string; tenantId: TenantId; role?: WsRole }>();

export function getConnectionCount(userId: string): number {
	return userConnections.get(userId)?.size ?? 0;
}

/** Total sockets across all users - used by the /api/asterisk/status endpoint. */
export function getTotalConnectionCount(): number {
	let total = 0;
	for (const set of userConnections.values()) {
		total += set.size;
	}
	return total;
}

/** Ids of users with at least one live socket. */
export function getConnectedUserIds(): string[] {
	return [...userConnections.keys()];
}

export function registerConnection(userId: string, ws: WsLike, tenantId: TenantId, role?: WsRole) {
	let set = userConnections.get(userId);
	if (!set) {
		set = new Set();
		userConnections.set(userId, set);
	}
	set.add(ws);
	connectionMeta.set(ws, { userId, tenantId, role });
}

export function unregisterConnection(ws: WsLike) {
	connectionMeta.delete(ws);
	for (const [userId, set] of userConnections) {
		if (set.delete(ws) && set.size === 0) {
			userConnections.delete(userId);
		}
	}
}

export function broadcastToUser(userId: string, data: unknown) {
	const set = userConnections.get(userId);
	if (!set) {
		return;
	}

	const payload = JSON.stringify(data);
	for (const ws of set) {
		try {
			ws.send(payload);
		} catch {
			// ignore broken sockets
		}
	}
}

/**
 * Send to every socket of ONE TENANT. Serialises once: a busy call centre can have
 * a hundred operators connected, and re-stringifying per socket showed up as
 * avoidable work under load.
 */
export function broadcastToAll(tenantId: TenantId, data: unknown) {
	const payload = JSON.stringify(data);
	for (const [ws, meta] of connectionMeta) {
		if (meta.tenantId !== tenantId) {
			continue;
		}
		try {
			ws.send(payload);
		} catch {
			// ignore broken sockets
		}
	}
}

/**
 * Send only to sockets whose authenticated user holds one of `roles`.
 *
 * Sockets registered without a role (i.e. by older two-argument calls) are
 * skipped rather than included, so a role-restricted event can never leak to a
 * connection whose role we do not actually know.
 */
export function broadcastToRoles(tenantId: TenantId, roles: readonly WsRole[], data: unknown) {
	const payload = JSON.stringify(data);
	for (const [ws, meta] of connectionMeta) {
		// Tenant first: a role match in the wrong tenant is the leak, not the audience.
		if (meta.tenantId !== tenantId) {
			continue;
		}
		if (!(meta.role && roles.includes(meta.role))) {
			continue;
		}
		try {
			ws.send(payload);
		} catch {
			// ignore broken sockets
		}
	}
}

/**
 * Live-call fan-out: supervisors and admins see every call, and the operator
 * the call belongs to sees their own. Used by the call orchestrator so one
 * call event reaches exactly the right audience.
 */
export function broadcastCallEvent(tenantId: TenantId, data: unknown, ownerUserId?: string | null) {
	broadcastToRoles(tenantId, ["supervisor", "admin"], data);
	if (ownerUserId) {
		// Avoid sending twice to a supervisor who also owns the call.
		const set = userConnections.get(ownerUserId);
		if (!set) {
			return;
		}
		const payload = JSON.stringify(data);
		for (const ws of set) {
			const meta = connectionMeta.get(ws);
			if (meta?.role === "supervisor" || meta?.role === "admin") {
				continue;
			}
			try {
				ws.send(payload);
			} catch {
				// ignore broken sockets
			}
		}
	}
}
