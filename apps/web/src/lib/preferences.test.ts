import { describe, expect, test, vi } from "vitest";
import type { Session } from "#/lib/auth.ts";
import {
	addNegativeCriterion,
	approveTitles,
	suggestTitles,
} from "#/lib/preferences.ts";

const session: Session = {
	accessToken: "access-1",
	refreshToken: "refresh-1",
	user: { id: "user-1", email: "a@b.com" },
};

describe("suggestTitles", () => {
	test("posts the feedback + current list and returns the suggestions", async () => {
		const post = vi
			.fn()
			.mockResolvedValue({ user: "user-1", suggestions: ["A", "B"] });

		const result = await suggestTitles(
			session,
			{ feedback: "re-rank", current: ["B", "A"] },
			post,
		);

		expect(post).toHaveBeenCalledWith(
			"/onboarding/titles/suggest",
			"access-1",
			{ userId: "user-1", feedback: "re-rank", current: ["B", "A"] },
		);
		expect(result).toEqual(["A", "B"]);
	});
});

describe("approveTitles", () => {
	test("persists the chosen titles", async () => {
		const post = vi.fn().mockResolvedValue(undefined);

		await approveTitles(session, ["A", "B"], post);

		expect(post).toHaveBeenCalledWith(
			"/onboarding/titles/approve",
			"access-1",
			{
				userId: "user-1",
				titles: ["A", "B"],
			},
		);
	});
});

describe("addNegativeCriterion", () => {
	test("captures a rule-out and returns the saved row", async () => {
		const post = vi.fn().mockResolvedValue({
			user: "user-1",
			criterion: { id: "c1", text: "nothing in .NET" },
		});

		const result = await addNegativeCriterion(session, "nothing in .NET", post);

		expect(post).toHaveBeenCalledWith("/criteria", "access-1", {
			userId: "user-1",
			text: "nothing in .NET",
		});
		expect(result).toEqual({ id: "c1", text: "nothing in .NET" });
	});
});
