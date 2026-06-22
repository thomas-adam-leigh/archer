import { describe, expect, test, vi } from "vitest";
import { AuthError, signIn, signOut, signUp } from "#/lib/auth.ts";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: () => Promise.resolve(body),
	} as unknown as Response;
}

const session = {
	access_token: "access-1",
	refresh_token: "refresh-1",
	user: { id: "user-1", email: "a@b.com" },
};

describe("signIn", () => {
	test("posts credentials and returns the session", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(session));

		const result = await signIn("a@b.com", "pw", fetchImpl);

		expect(fetchImpl).toHaveBeenCalledWith(
			"https://supabase.test/auth/v1/token?grant_type=password",
			expect.objectContaining({ method: "POST" }),
		);
		expect(result).toEqual({
			accessToken: "access-1",
			refreshToken: "refresh-1",
			user: { id: "user-1", email: "a@b.com" },
		});
	});

	test("surfaces the GoTrue error message", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ error_description: "Invalid login" }, false, 400),
			);

		await expect(signIn("a@b.com", "bad", fetchImpl)).rejects.toThrow(
			"Invalid login",
		);
		await expect(signIn("a@b.com", "bad", fetchImpl)).rejects.toBeInstanceOf(
			AuthError,
		);
	});
});

describe("signUp", () => {
	test("returns the session when tokens are issued", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(session));

		const result = await signUp("a@b.com", "pw", fetchImpl);

		expect(result.session?.accessToken).toBe("access-1");
	});

	test("returns null session when email confirmation is required", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ user: { id: "u", email: "a@b.com" } }));

		const result = await signUp("a@b.com", "pw", fetchImpl);

		expect(result.session).toBeNull();
	});
});

describe("signOut", () => {
	test("revokes the token locally and swallows network failures", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

		await expect(signOut("access-1", fetchImpl)).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://supabase.test/auth/v1/logout?scope=local",
			expect.objectContaining({ method: "POST" }),
		);
	});
});
