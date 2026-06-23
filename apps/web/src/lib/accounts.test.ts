import { describe, expect, test, vi } from "vitest";
import { completeOnboarding } from "#/lib/accounts.ts";
import type { Session } from "#/lib/auth.ts";

const session: Session = {
	accessToken: "access-1",
	refreshToken: "refresh-1",
	user: { id: "user-1", email: "a@b.com" },
};

describe("completeOnboarding", () => {
	test("submits the account for the Acceptance Gate and returns the status", async () => {
		const post = vi
			.fn()
			.mockResolvedValue({ user: "user-1", status: "submitted" });

		const status = await completeOnboarding(session, post);

		expect(post).toHaveBeenCalledWith("/onboarding/complete", "access-1", {
			userId: "user-1",
		});
		expect(status).toBe("submitted");
	});

	test("propagates the readiness 409 when onboarding is incomplete", async () => {
		const post = vi
			.fn()
			.mockRejectedValue(new Error("onboarding incomplete: no target titles"));

		await expect(completeOnboarding(session, post)).rejects.toThrow(
			"onboarding incomplete",
		);
	});
});
