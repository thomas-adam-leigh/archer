import { describe, expect, test, vi } from "vitest";
import type { Session } from "#/lib/auth.ts";
import {
	addNegativeCriterion,
	approveTitles,
	listNegativeCriteria,
	removeNegativeCriterion,
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

describe("listNegativeCriteria", () => {
	test("reads the user-scoped list and returns the rows", async () => {
		const get = vi.fn().mockResolvedValue({
			user: "user-1",
			criteria: [
				{ id: "c1", text: "nothing in .NET" },
				{ id: "c2", text: "no on-site" },
			],
		});

		const result = await listNegativeCriteria(session, get);

		expect(get).toHaveBeenCalledWith("/criteria?user=user-1", "access-1");
		expect(result).toEqual([
			{ id: "c1", text: "nothing in .NET" },
			{ id: "c2", text: "no on-site" },
		]);
	});

	test("defaults to an empty list when none are returned", async () => {
		const get = vi.fn().mockResolvedValue({ user: "user-1" });

		expect(await listNegativeCriteria(session, get)).toEqual([]);
	});
});

describe("removeNegativeCriterion", () => {
	test("deletes the row by id", async () => {
		const del = vi.fn().mockResolvedValue({ removed: "c1" });

		await removeNegativeCriterion(session, "c1", del);

		expect(del).toHaveBeenCalledWith("/criteria/c1", "access-1");
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
