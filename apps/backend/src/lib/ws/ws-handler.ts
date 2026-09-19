import type { TenantId } from "@shared/types";
import type { Context } from "hono";
import type { WSEvents } from "hono/ws";

import { verifyAccessToken } from "@/lib/auth/jwt";
import type { AppBindings } from "@/lib/types";
import { registerConnection, unregisterConnection, type WsRole } from "./registry";

/**
 * WebSocket events: faqat JWT token bilan autentifikatsiya.
 * Client: ws://host/api/ws?token=ACCESS_TOKEN
 */
export async function createWsEvents(c: Context<AppBindings>): Promise<WSEvents> {
	const url = new URL(c.req.url);
	const token = url.searchParams.get("token");

	if (!token) {
		return {
			onOpen(_evt, ws) {
				ws.close(1008, "Missing token");
			},
		};
	}

	let userId: string;
	// Captured so the registry can fan events out by role (live-call and
	// transcript events go to supervisors/admins, not to every operator).
	let role: WsRole | undefined;
	// And by tenant, which is what stops one customer's live board from receiving
	// another customer's calls. Taken from the token, never from the query string.
	let tenantId: TenantId;
	try {
		const payload = await verifyAccessToken(token);
		userId = payload.sub;
		// AccessTokenPayload.role is UserRoleType, which is exactly WsRole.
		role = payload.role;
		tenantId = payload.tid;
	} catch {
		return {
			onOpen(_evt, ws) {
				ws.close(1008, "Invalid or expired token");
			},
		};
	}

	return {
		onOpen(_evt, ws) {
			registerConnection(userId, ws, tenantId, role);
			ws.send(
				JSON.stringify({
					type: "connected",
					message: "WebSocket connected",
					userId,
				})
			);
		},
		onMessage(_evt, ws) {
			ws.send(
				JSON.stringify({
					type: "pong",
					message: "message received",
				})
			);
		},
		onClose(_evt, ws) {
			unregisterConnection(ws);
		},
	};
}
