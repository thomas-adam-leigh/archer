import { describe, expect, test, vi } from "vitest";
import type { Session } from "#/lib/auth.ts";
import {
	buildProfileFromAnswers,
	finalizeGuidedOnboarding,
	ingestAnswer,
} from "#/lib/conversation.ts";

const session: Session = {
	accessToken: "access-1",
	refreshToken: "refresh-1",
	user: { id: "user-1", email: "a@b.com" },
};

describe("ingestAnswer", () => {
	test("persists an answer to the thread via /onboarding/voicenote", async () => {
		const post = vi.fn().mockResolvedValue({ messageId: "m1" });

		await ingestAnswer(
			session,
			{ threadId: "t1", transcript: "I'm Jane." },
			post,
		);

		expect(post).toHaveBeenCalledWith("/onboarding/voicenote", "access-1", {
			threadId: "t1",
			transcript: "I'm Jane.",
			provider: "scripted-onboarding",
		});
	});
});

describe("finalizeGuidedOnboarding", () => {
	test("structures the thread's answers and returns the proposal", async () => {
		const post = vi.fn().mockResolvedValue({
			versionId: "v1",
			proposalId: "p1",
			status: "proposed",
		});

		const result = await finalizeGuidedOnboarding(session, "t1", post);

		expect(post).toHaveBeenCalledWith("/onboarding/guided", "access-1", {
			threadId: "t1",
		});
		expect(result).toEqual({ versionId: "v1", proposalId: "p1" });
	});
});

describe("buildProfileFromAnswers", () => {
	test("resolves the thread, persists each answer in order, then finalizes", async () => {
		const calls: string[] = [];
		const resolveThreadId = vi.fn().mockResolvedValue("t1");
		const ingest = vi.fn(async (_s, args: { transcript: string }) => {
			calls.push(`ingest:${args.transcript}`);
		});
		const finalize = vi.fn(async () => {
			calls.push("finalize");
			return { versionId: "v1", proposalId: "p1" };
		});

		const result = await buildProfileFromAnswers(
			session,
			["I'm Jane, a designer.", "Most recently at Acme."],
			{ resolveThreadId, ingest, finalize },
		);

		expect(resolveThreadId).toHaveBeenCalledWith(session);
		expect(ingest).toHaveBeenCalledTimes(2);
		expect(ingest).toHaveBeenNthCalledWith(1, session, {
			threadId: "t1",
			transcript: "I'm Jane, a designer.",
		});
		expect(ingest).toHaveBeenNthCalledWith(2, session, {
			threadId: "t1",
			transcript: "Most recently at Acme.",
		});
		// Answers are persisted before the structurer runs, and in script order.
		expect(calls).toEqual([
			"ingest:I'm Jane, a designer.",
			"ingest:Most recently at Acme.",
			"finalize",
		]);
		expect(finalize).toHaveBeenCalledWith(session, "t1");
		expect(result).toEqual({ versionId: "v1", proposalId: "p1" });
	});

	test("trims and skips blank answers, persisting only real ones", async () => {
		const resolveThreadId = vi.fn().mockResolvedValue("t1");
		const ingest = vi.fn().mockResolvedValue(undefined);
		const finalize = vi
			.fn()
			.mockResolvedValue({ versionId: "v1", proposalId: "p1" });

		await buildProfileFromAnswers(session, ["  hi  ", "   ", ""], {
			resolveThreadId,
			ingest,
			finalize,
		});

		expect(ingest).toHaveBeenCalledTimes(1);
		expect(ingest).toHaveBeenCalledWith(session, {
			threadId: "t1",
			transcript: "hi",
		});
	});

	test("rejects an all-empty answer set before any network call", async () => {
		const resolveThreadId = vi.fn();
		const ingest = vi.fn();
		const finalize = vi.fn();

		await expect(
			buildProfileFromAnswers(session, ["", "   "], {
				resolveThreadId,
				ingest,
				finalize,
			}),
		).rejects.toThrow(/answer at least one question/i);
		expect(resolveThreadId).not.toHaveBeenCalled();
		expect(ingest).not.toHaveBeenCalled();
		expect(finalize).not.toHaveBeenCalled();
	});

	test("propagates a finalize failure (no proposal returned)", async () => {
		const resolveThreadId = vi.fn().mockResolvedValue("t1");
		const ingest = vi.fn().mockResolvedValue(undefined);
		const finalize = vi
			.fn()
			.mockRejectedValue(new Error("guided onboarding failed"));

		await expect(
			buildProfileFromAnswers(session, ["hi"], {
				resolveThreadId,
				ingest,
				finalize,
			}),
		).rejects.toThrow(/guided onboarding failed/);
	});
});
