/**
 * Authenticated client for the Archer API (ported from
 * `apps/mobile/src/lib/api.ts`).
 *
 * A thin typed wrapper over the browser `fetch`: it targets the Hono API base
 * (`getArcherApiUrl()`), injects the user's `Authorization: Bearer
 * <accessToken>`, sends/parses JSON, and turns non-2xx responses into a typed
 * {@link ApiError}. Used app-wide for every action the client dispatches.
 */

import { getArcherApiUrl } from "#/lib/config.ts";

/** A failed API call, carrying the HTTP status and parsed body for callers. */
export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

interface ApiErrorBody {
	error?: string;
	message?: string;
}

/** Parse a JSON body, tolerating empty (e.g. 204) and non-JSON responses. */
async function readBody(res: Response): Promise<unknown> {
	const text = await res.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function errorMessage(body: unknown, status: number): string {
	const b = body as ApiErrorBody | null;
	return b?.error ?? b?.message ?? `Request failed with status ${status}`;
}

async function request<T>(
	path: string,
	init: {
		method: string;
		accessToken: string;
		body?: unknown;
		fetchImpl?: typeof fetch;
	},
): Promise<T> {
	const fetchImpl = init.fetchImpl ?? fetch;
	const res = await fetchImpl(`${getArcherApiUrl()}${path}`, {
		method: init.method,
		headers: {
			Authorization: `Bearer ${init.accessToken}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const body = await readBody(res);
	if (!res.ok) {
		throw new ApiError(errorMessage(body, res.status), res.status, body);
	}
	return body as T;
}

/** Authenticated GET, parsing the JSON response as `T`. */
export function apiGet<T>(
	path: string,
	accessToken: string,
	fetchImpl?: typeof fetch,
): Promise<T> {
	return request<T>(path, { method: "GET", accessToken, fetchImpl });
}

/** Authenticated POST with an optional JSON body, parsing the response as `T`. */
export function apiPost<T>(
	path: string,
	accessToken: string,
	body?: unknown,
	fetchImpl?: typeof fetch,
): Promise<T> {
	return request<T>(path, { method: "POST", accessToken, body, fetchImpl });
}

/** Authenticated DELETE, parsing the JSON response as `T`. */
export function apiDelete<T>(
	path: string,
	accessToken: string,
	fetchImpl?: typeof fetch,
): Promise<T> {
	return request<T>(path, { method: "DELETE", accessToken, fetchImpl });
}
