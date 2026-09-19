/**
 * The tenant of a child row, taken from the parent row it hangs off.
 *
 * THE PROBLEM THIS SOLVES. The voice layer writes a dozen kinds of row during a
 * call - a transcript utterance, a recording, a note, a follow-up - from functions
 * that receive a callId and nothing else. Three ways to give those rows a tenant:
 *
 *   1. thread a tenantId through every input interface. Correct, and the shape this
 *      ends up in once the dialplan tells the orchestrator which tenant is calling.
 *      Today the orchestrator does not know, so it would be threading a guess.
 *   2. look the parent up first. An extra round trip per utterance, and a window
 *      between the lookup and the insert.
 *   3. let Postgres read it, inside the same statement that writes the row.
 *
 * This module is option 3, and it is the safest of the three while option 1 is not
 * yet available: the tenant is not passed, not cached and not guessed - it is read
 * from the parent row the child is being attached to, atomically. A child cannot
 * land in a different tenant than its parent, because the value comes FROM the
 * parent. If the parent does not exist the subquery is NULL and the NOT NULL
 * constraint rejects the insert, which is the correct outcome for a child of a call
 * that is not there.
 *
 * When the orchestrator learns its tenant, these calls become plain values and this
 * module can go. Until then it is the seam, and it is greppable.
 */
import type { TenantId } from "@shared/types";
import { type SQL, sql } from "drizzle-orm";

import { calls, contacts, tickets } from "@/db/schema";

/** `(select tenant_id from calls where id = $callId)` */
export function tenantIdOfCall(callId: string): SQL<TenantId> {
	return sql<TenantId>`(select ${calls.tenantId} from ${calls} where ${calls.id} = ${callId})`;
}

/** `(select tenant_id from tickets where id = $ticketId)` */
export function tenantIdOfTicket(ticketId: string): SQL<TenantId> {
	return sql<TenantId>`(select ${tickets.tenantId} from ${tickets} where ${tickets.id} = ${ticketId})`;
}

/** `(select tenant_id from contacts where id = $contactId)` */
export function tenantIdOfContact(contactId: string): SQL<TenantId> {
	return sql<TenantId>`(select ${contacts.tenantId} from ${contacts} where ${contacts.id} = ${contactId})`;
}

/**
 * The tenant of whichever parent this row actually has.
 *
 * Some rows may hang off a call, a ticket or a contact - a note, a follow-up task -
 * and exactly one of them is guaranteed present by the caller's own validation.
 * Preference order is call, then ticket, then contact: the call is the most specific
 * parent and the one that always carries the tenant the work was done for.
 */
export function tenantIdOfParent(parents: {
	callId?: string | null;
	ticketId?: string | null;
	contactId?: string | null;
}): SQL<TenantId> {
	if (parents.callId) {
		return tenantIdOfCall(parents.callId);
	}

	if (parents.ticketId) {
		return tenantIdOfTicket(parents.ticketId);
	}

	if (parents.contactId) {
		return tenantIdOfContact(parents.contactId);
	}

	// Not reachable from a validated caller. Throwing beats inserting a row whose
	// tenant would have to be invented.
	throw new Error("Cannot derive a tenant: the row has no call, ticket or contact");
}
