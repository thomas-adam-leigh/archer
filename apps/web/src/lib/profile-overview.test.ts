import { describe, expect, test, vi } from "vitest";
import type { Session } from "#/lib/auth.ts";
import {
	fetchProfileOverview,
	versionBadge,
	versionDate,
} from "#/lib/profile-overview.ts";

const session: Session = {
	accessToken: "access-1",
	refreshToken: "refresh-1",
	user: { id: "user-1", email: "a@b.com" },
};

describe("fetchProfileOverview", () => {
	test("reads profile + versions, then the live version's spine", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce({
				user: "user-1",
				profile: { work_pref: "remote", willing_remote: true, attributes: {} },
			})
			.mockResolvedValueOnce({
				user: "user-1",
				versions: [
					{
						id: "v1",
						version_no: 1,
						status: "superseded",
						label: null,
						created_at: "2026-01-01",
					},
					{
						id: "v2",
						version_no: 2,
						status: "approved",
						label: "live",
						created_at: "2026-02-01",
					},
				],
				liveVersionId: "v2",
			})
			.mockResolvedValueOnce({ spine: { skills: [{ name: "TS" }] } });

		const overview = await fetchProfileOverview(session, get);

		// profile + versions read in parallel (user-scoped), spine from the live id.
		expect(get).toHaveBeenNthCalledWith(1, "/profile?user=user-1", "access-1");
		expect(get).toHaveBeenNthCalledWith(
			2,
			"/profile/versions?user=user-1",
			"access-1",
		);
		expect(get).toHaveBeenNthCalledWith(
			3,
			"/profile/versions/v2?user=user-1",
			"access-1",
		);
		expect(overview.liveVersionId).toBe("v2");
		expect(overview.spine).toEqual({ skills: [{ name: "TS" }] });
		expect(overview.proposedVersionId).toBeNull();
	});

	test("skips the spine read when there's no live version", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce({ user: "user-1", profile: null })
			.mockResolvedValueOnce({
				user: "user-1",
				versions: [],
				liveVersionId: null,
			});

		const overview = await fetchProfileOverview(session, get);

		expect(get).toHaveBeenCalledTimes(2);
		expect(overview.profile).toBeNull();
		expect(overview.spine).toEqual({});
	});

	test("surfaces an open proposed version as the proposal gate", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce({ user: "user-1", profile: null })
			.mockResolvedValueOnce({
				user: "user-1",
				versions: [
					{
						id: "v3",
						version_no: 3,
						status: "proposed",
						label: null,
						created_at: "2026-03-01",
					},
				],
				liveVersionId: null,
			});

		const overview = await fetchProfileOverview(session, get);
		expect(overview.proposedVersionId).toBe("v3");
	});
});

describe("versionBadge", () => {
	test("the live version reads Live regardless of status", () => {
		expect(versionBadge("approved", true)).toEqual({
			label: "Live",
			tone: "live",
		});
	});
	test("an open proposal reads Awaiting review", () => {
		expect(versionBadge("proposed", false)).toEqual({
			label: "Awaiting review",
			tone: "proposed",
		});
	});
	test("an earlier snapshot reads Previous", () => {
		expect(versionBadge("superseded", false)).toEqual({
			label: "Previous",
			tone: "neutral",
		});
	});
});

describe("versionDate", () => {
	test("renders a parseable date and tolerates a bad one", () => {
		expect(versionDate("2026-02-01T00:00:00Z")).not.toBe("");
		expect(versionDate("not-a-date")).toBe("");
	});
});
