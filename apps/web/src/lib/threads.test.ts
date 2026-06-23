import { describe, expect, test, vi } from "vitest";
import type { Session } from "#/lib/auth.ts";
import { fetchPrimaryThreadId, ThreadLookupError } from "#/lib/threads.ts";

const session: Session = {
	accessToken: "access-1",
	refreshToken: "refresh-1",
	user: { id: "user-1", email: "a@b.com" },
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: () => Promise.resolve(body),
	} as unknown as Response;
}

describe("fetchPrimaryThreadId", () => {
	test("reads the earliest thread from PostgREST with the user's JWT + apikey", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ id: "thread-1" }]));

		const id = await fetchPrimaryThreadId(session, fetchImpl);

		expect(id).toBe("thread-1");
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe(
			"https://supabase.test/rest/v1/threads?select=id&order=created_at.asc&limit=1",
		);
		expect(init.headers).toMatchObject({
			apikey: "pk-test",
			Authorization: "Bearer access-1",
		});
	});

	test("throws a ThreadLookupError on a non-2xx response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null, false, 401));

		await expect(
			fetchPrimaryThreadId(session, fetchImpl),
		).rejects.toBeInstanceOf(ThreadLookupError);
	});

	test("throws when the user has no thread", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

		await expect(
			fetchPrimaryThreadId(session, fetchImpl),
		).rejects.toBeInstanceOf(ThreadLookupError);
	});
});
