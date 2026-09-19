import { randomUUID } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";
import { eq, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { callRecordings, calls } from "@/db/schema";
import { verifyAccessToken } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { asTenantId, getTenantById, isTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";

import type { getCallRecording, getTenantCallRecording, uploadRecording } from "./uploads.routes";

/**
 * The one directory recordings may be served from.
 *
 * import.meta.dir is apps/backend/src/routes/uploads; up 3 is apps/backend.
 */
const RECORDINGS_ROOT = resolve(import.meta.dir, "../../../uploads/call-recordings");

export const uploadRecordingHandler: AppRouteHandler<typeof uploadRecording> = async (c) => {
	const contentType = c.req.header("content-type") || "";
	if (!contentType.startsWith("multipart/form-data")) {
		return c.json({ success: false, error: { message: "Fayl turi noto'g'ri" } }, 400);
	}

	const formData = await c.req.formData();
	const file = formData.get("file");

	if (!(file instanceof File)) {
		return c.json({ success: false, error: { message: "Fayl yuborilmadi" } }, 400);
	}

	const ext = file.name.split(".").pop() || "webm";
	const fileName = `${randomUUID()}.${ext}`;
	const relativePath = `/uploads/call-recordings/${fileName}`;

	// Save into backend's uploads folder (absolute path)
	const recordingsDir = join(import.meta.dir, "../../../uploads/call-recordings");
	const filePath = join(recordingsDir, fileName);
	const bunFile = Bun.file(filePath);
	await Bun.write(bunFile, file);

	// `created()` o'rniga to'g'ridan-to'g'ri `c.json(..., 201)`: natija bir xil
	// (201 + bir xil tana), ammo TypeScript status kodini route e'loni bilan
	// solishtira oladi.
	return c.json({ success: true as const, data: { path: relativePath } }, 201);
};

/**
 * Whose recording this file is - by FILE NAME, which is a natural key rather than an
 * id, and therefore exactly the shape of lookup that escapes a tenant scope.
 *
 * Two places record a file: `call_recordings` (the AI/ARI path) and
 * `calls.recording_path` (the legacy webhook and browser uploads), and the stored
 * value is a full path in the first case and a URL path in the second - so both are
 * compared on their last segment. Returns null for a file no call in this tenant
 * owns, which the caller turns into a 404.
 */
async function recordingBelongsToTenant(tenantId: TenantId, fileName: string): Promise<boolean> {
	const [owned] = await db
		.select({ id: callRecordings.id })
		.from(callRecordings)
		.where(
			tenantWhere(
				callRecordings,
				tenantId,
				or(
					eq(callRecordings.fileName, fileName),
					sql`regexp_replace(${callRecordings.filePath}, '^.*[\\\\/]', '') = ${fileName}`
				)
			)
		)
		.limit(1);

	if (owned !== undefined) {
		return true;
	}

	const [fallback] = await db
		.select({ id: calls.id })
		.from(calls)
		.where(
			tenantWhere(
				calls,
				tenantId,
				sql`regexp_replace(${calls.recordingPath}, '^.*[\\\\/]', '') = ${fileName}`
			)
		)
		.limit(1);

	return fallback !== undefined;
}

/**
 * THE PATH BOUNDARY. Resolve the requested segments inside the recordings root and
 * refuse anything that ends up outside it.
 *
 * This route is deliberately unauthenticated (see below), so path handling is not a
 * convenience here - it is the only thing standing between one customer's audio and
 * another customer's guess. Belt and braces on purpose: the route schemas already
 * reject anything that is not [a-z0-9-] / [A-Za-z0-9._-], basename() strips any
 * directory that survived, and this check then proves the resolved result is still
 * under the root. Any one of the three would do; all three means a later edit to one
 * of them cannot quietly open a traversal.
 */
function recordingPathInside(segments: readonly string[]): string | null {
	const safe = segments.map((segment) => basename(segment));

	if (safe.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		return null;
	}

	const candidate = resolve(join(RECORDINGS_ROOT, ...safe));
	const inside = relative(RECORDINGS_ROOT, candidate);

	if (inside.length === 0 || inside.startsWith("..") || inside.startsWith(`${sep}..`)) {
		return null;
	}

	return candidate;
}

/** Content type for browser playback, from the extension we wrote. */
function audioContentType(fileName: string): string {
	if (fileName.endsWith(".webm")) {
		return "audio/webm";
	}

	if (fileName.endsWith(".wav")) {
		return "audio/wav";
	}

	if (fileName.endsWith(".mp3")) {
		return "audio/mpeg";
	}

	return "application/octet-stream";
}

/**
 * The tenant of the request, IF it carries a token - otherwise null.
 *
 * This route is deliberately not behind authMiddleware and cannot be: the browser
 * plays a recording through `<audio src>` and `<a download>`, and neither element can
 * send an Authorization header. So the tenant is read when it is offered and the
 * request is served without one when it is not, which is exactly what happened before
 * this change.
 *
 * WHAT THAT DOES AND DOES NOT CLOSE, plainly, because a half-lock described as a lock
 * is worse than no lock:
 *   - CLOSED: a logged-in user of customer B who has somehow obtained a URL for
 *     customer A's recording (a shared link, a copied address, a browser history on a
 *     shared machine) now gets 404 instead of the audio. So does any authenticated
 *     request whose file name belongs to no call of its own tenant.
 *   - NOT CLOSED: an anonymous request with a correct file name is still served. The
 *     names are v4 uuids, so they cannot be enumerated, and after this workflow no
 *     authenticated endpoint reveals another tenant's file names - but a leaked URL is
 *     still a working URL.
 *   - CLOSED SINCE, by the phase that owns recording isolation: recordings live in
 *     per-tenant directories and are served through a route with the tenant slug in
 *     it, and an authenticated request for a directory that is not its own tenant is
 *     refused before the disk is touched. A leaked URL is still a working URL - that
 *     needs a signed URL or a blob-fetching player, which is a change to the frontend
 *     and to a working feature - but the file name is no longer the only thing
 *     separating two customers' audio: the path is, and the path is checked.
 */
async function tenantOfRequest(header: string | undefined): Promise<TenantId | null> {
	if (!header?.startsWith("Bearer ")) {
		return null;
	}

	const token = header.slice(7);

	if (token.length === 0) {
		return null;
	}

	try {
		const payload = await verifyAccessToken(token);

		return isTenantId(payload.tid) ? asTenantId(payload.tid) : null;
	} catch {
		// A bad token is treated as no token: this endpoint's contract is that it may be
		// called without one, so failing the request would break the player instead.
		return null;
	}
}

/**
 * Serve one recording, having decided nothing about who may hear it yet.
 *
 * `tenantDirectory` is the slug from the URL, or null for the flat pre-tenancy
 * shape. When it is present it must be the requester's OWN tenant - a token for
 * customer B asking for customer A's directory is a 404, not a 403, because whether
 * that directory exists is itself information about another customer.
 */
async function serveRecording(
	authorization: string | undefined,
	tenantDirectory: string | null,
	fileName: string
): Promise<Response> {
	const safeFileName = basename(fileName);
	const tenantId = await tenantOfRequest(authorization);

	if (tenantId !== null) {
		if (tenantDirectory !== null) {
			const tenant = await getTenantById(tenantId);

			if (tenant === null || tenant.slug !== tenantDirectory) {
				throw notFound("Qo'ng'iroq yozuvi", safeFileName);
			}
		}

		if (!(await recordingBelongsToTenant(tenantId, safeFileName))) {
			// Not 403: whether a file exists at all is information about another customer's
			// calls, and this is the same answer a made-up file name gets.
			throw notFound("Qo'ng'iroq yozuvi", safeFileName);
		}
	}

	const filePath = recordingPathInside(
		tenantDirectory === null ? [safeFileName] : [tenantDirectory, safeFileName]
	);

	if (filePath === null) {
		throw notFound("Qo'ng'iroq yozuvi", safeFileName);
	}

	const file = Bun.file(filePath);

	if (!(await file.exists())) {
		throw notFound("Qo'ng'iroq yozuvi", safeFileName);
	}

	return new Response(file, {
		headers: {
			"Content-Type": audioContentType(safeFileName),
			"Cache-Control": "public, max-age=31536000",
		},
	});
}

export const getCallRecordingHandler: AppRouteHandler<typeof getCallRecording> = async (c) => {
	const { fileName } = c.req.valid("param");

	return await serveRecording(c.req.header("authorization"), null, fileName);
};

export const getTenantCallRecordingHandler: AppRouteHandler<typeof getTenantCallRecording> = async (
	c
) => {
	const { tenantSlug, fileName } = c.req.valid("param");

	return await serveRecording(c.req.header("authorization"), tenantSlug, fileName);
};
