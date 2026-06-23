/**
 * The "start from scratch" finalize: turn the scripted Q&A answers into a PROPOSED
 * profile version (ported from `apps/mobile/src/lib/conversation.ts`, web-idiomatic).
 *
 * Onboarding from scratch is a FIXED, static script (no generative chat) — the
 * candidate answers Archer's preset questions, by voice or text, and those answers
 * are captured client-side (`onboarding-script.ts`). The only AI here is
 * EXTRACTION, and the backend exposes it as a whole-transcript finalize, not a
 * per-answer call:
 *
 *  1. Each captured answer is persisted to the user's thread as a message via
 *     `POST /onboarding/voicenote` (the documented voice → transcript → message
 *     seam; audio never leaves the browser, only the text is sent).
 *  2. `POST /onboarding/guided` then reads the thread's gathered answers, structures
 *     them into a profile draft (attributes + spine) with the SAME structurer the
 *     résumé path uses, and submits a PROPOSED profile version — converging on the
 *     same review screen (M6) the résumé path lands on.
 *
 * There is no endpoint that extracts a single answer into structured fields, so the
 * live "profile, taking shape" panel reflects the captured answers as they come in
 * and the structured draft is produced once, at finalize (see ARC-105 notes). The
 * network seams are injectable so the suite runs fully offline.
 */

import { apiPost } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";

/** The proposed version the guided finalize produced — handed to the review step. */
export interface GuidedOnboardingResult {
	versionId: string;
	proposalId: string;
}

/** The POST surface the calls need — injectable so they can be tested offline. */
export type ConversationPost = <T>(
	path: string,
	accessToken: string,
	body?: unknown,
) => Promise<T>;

/**
 * Persist one captured answer to the user's thread as a message, via the voicenote
 * ingest seam (`POST /onboarding/voicenote`). The transcript is the candidate's
 * answer text — typed or already transcribed from voice; no audio is sent. The
 * owner is resolved from the thread server-side, not trusted from the client.
 */
export async function ingestAnswer(
	session: Session,
	args: { threadId: string; transcript: string },
	post: ConversationPost = apiPost,
): Promise<void> {
	await post("/onboarding/voicenote", session.accessToken, {
		threadId: args.threadId,
		transcript: args.transcript,
		provider: "scripted-onboarding",
	});
}

/**
 * Finalize the scripted onboarding: structure the thread's gathered answers into a
 * proposed profile version (`POST /onboarding/guided`), so the candidate can review
 * it. Returns the proposed version's `versionId`/`proposalId`.
 */
export async function finalizeGuidedOnboarding(
	session: Session,
	threadId: string,
	post: ConversationPost = apiPost,
): Promise<GuidedOnboardingResult> {
	const resp = await post<{ versionId: string; proposalId: string }>(
		"/onboarding/guided",
		session.accessToken,
		{ threadId },
	);
	return { versionId: resp.versionId, proposalId: resp.proposalId };
}

/** Injectable seams for {@link buildProfileFromAnswers}. */
export interface ScratchFlowDeps {
	/** Resolve the thread the answers attach to (the bootstrap thread). */
	resolveThreadId(session: Session): Promise<string>;
	ingest?: typeof ingestAnswer;
	finalize?: typeof finalizeGuidedOnboarding;
}

/**
 * The whole scratch finalize as one call the screen awaits: resolve the thread →
 * persist each captured answer to it (in order) → structure them into a PROPOSED
 * profile version. Returns the proposed version's `versionId`/`proposalId` for the
 * review step. Answers are persisted in the order given so the transcript reads in
 * script order; an empty list is rejected before any network call so finalize can't
 * propose a profile from nothing.
 */
export async function buildProfileFromAnswers(
	session: Session,
	answers: readonly string[],
	deps: ScratchFlowDeps,
): Promise<GuidedOnboardingResult> {
	const ingest = deps.ingest ?? ingestAnswer;
	const finalize = deps.finalize ?? finalizeGuidedOnboarding;

	const transcripts = answers.map((a) => a.trim()).filter((a) => a.length > 0);
	if (transcripts.length === 0) {
		throw new Error(
			"Answer at least one question before building your profile.",
		);
	}

	const threadId = await deps.resolveThreadId(session);
	for (const transcript of transcripts) {
		await ingest(session, { threadId, transcript });
	}
	return finalize(session, threadId);
}
