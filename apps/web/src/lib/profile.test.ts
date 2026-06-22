import { describe, expect, test, vi } from "vitest";
import type { Session } from "#/lib/auth.ts";
import {
	approveProposedDraft,
	fetchProposedProfileDraft,
	NoProposedVersionError,
} from "#/lib/profile.ts";

const session: Session = {
	accessToken: "access-1",
	refreshToken: "refresh-1",
	user: { id: "user-1", email: "a@b.com" },
};

describe("fetchProposedProfileDraft", () => {
	test("resolves the proposed version then reads its detail + spine", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce({
				versions: [
					{ id: "v1", status: "approved", attributes: {} },
					{ id: "v2", status: "proposed", attributes: { summary: "hi" } },
				],
				liveVersionId: "v1",
			})
			.mockResolvedValueOnce({
				version: {
					id: "v2",
					status: "proposed",
					attributes: { summary: "hi" },
				},
				spine: { skills: [{ name: "TS" }] },
			});

		const draft = await fetchProposedProfileDraft(session, get);

		expect(get).toHaveBeenNthCalledWith(
			1,
			"/profile/versions?user=user-1",
			"access-1",
		);
		expect(get).toHaveBeenNthCalledWith(
			2,
			"/profile/versions/v2?user=user-1",
			"access-1",
		);
		expect(draft.version.id).toBe("v2");
		expect(draft.spine.skills?.[0]?.name).toBe("TS");
	});

	test("throws NoProposedVersionError when nothing is awaiting review", async () => {
		const get = vi
			.fn()
			.mockResolvedValue({ versions: [], liveVersionId: null });

		await expect(
			fetchProposedProfileDraft(session, get),
		).rejects.toBeInstanceOf(NoProposedVersionError);
	});
});

describe("approveProposedDraft", () => {
	test("self-decides the proposal with the user id", async () => {
		const post = vi.fn().mockResolvedValue(undefined);

		await approveProposedDraft(session, "prop-1", post);

		expect(post).toHaveBeenCalledWith(
			"/onboarding/proposals/prop-1/decide/self",
			"access-1",
			{ userId: "user-1", action: "approve" },
		);
	});
});
