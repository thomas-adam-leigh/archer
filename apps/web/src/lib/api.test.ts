import { describe, expect, test, vi } from "vitest";
import { ApiError, apiGet, apiPost } from "#/lib/api.ts";

function textResponse(text: string, ok = true, status = 200): Response {
	return {
		ok,
		status,
		text: () => Promise.resolve(text),
	} as unknown as Response;
}

describe("apiGet", () => {
	test("targets the API base with a bearer token and parses JSON", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(textResponse(JSON.stringify({ ok: true })));

		const result = await apiGet<{ ok: boolean }>(
			"/onboarding/progress",
			"access-1",
			fetchImpl,
		);

		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://api.test/onboarding/progress");
		expect(init.method).toBe("GET");
		expect(init.headers.Authorization).toBe("Bearer access-1");
		expect(result).toEqual({ ok: true });
	});
});

describe("apiPost", () => {
	test("serializes the body", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(textResponse(""));

		await apiPost("/criteria", "access-1", { text: "no .NET" }, fetchImpl);

		const [, init] = fetchImpl.mock.calls[0];
		expect(init.body).toBe(JSON.stringify({ text: "no .NET" }));
	});

	test("throws a typed ApiError on a non-2xx response", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				textResponse(JSON.stringify({ error: "nope" }), false, 403),
			);

		await expect(
			apiPost("/criteria", "access-1", {}, fetchImpl),
		).rejects.toMatchObject({ status: 403 });
		await expect(
			apiPost("/criteria", "access-1", {}, fetchImpl),
		).rejects.toBeInstanceOf(ApiError);
	});
});
