/**
 * The conversational "start from scratch" path of onboarding (ARC-80).
 *
 * Where the résumé path uploads a file, this path is a guided multi-turn chat:
 * Archer asks about the candidate's work, education, skills and goals over the
 * AG-UI run loop (`POST /agui/run`, driven by the shared {@link ThreadSession}),
 * accreting a transcript. When the candidate is ready, this finalize call folds
 * that conversation into a structured draft (attributes + spine) and submits it
 * as a PROPOSED profile version — converging on the SAME review screen the résumé
 * path lands on (Milestone 5).
 *
 * The asking happens over the thread session; the only bespoke backend call is the
 * finalize below, mirroring `reviseProposedDraft` in `profile.ts`.
 */

import { apiPost } from './api.js';
import type { Session } from './auth.js';

/** The proposed version the guided finalize produced — handed to the review step. */
export interface GuidedOnboardingResult {
  versionId: string;
  proposalId: string;
}

/** The POST surface the finalize needs — injectable so it can be tested offline. */
export type ConversationPost = <T>(
  path: string,
  accessToken: string,
  body?: unknown,
) => Promise<T>;

/**
 * Finalize the conversational onboarding: structure the thread's gathered
 * conversation into a proposed profile version (`POST /onboarding/guided`), so the
 * candidate can review it. Returns the proposed version's `versionId`/`proposalId`.
 * The owner is resolved from the thread server-side, not trusted from the client.
 */
export async function finalizeGuidedOnboarding(
  session: Session,
  threadId: string,
  post: ConversationPost = apiPost,
): Promise<GuidedOnboardingResult> {
  const resp = await post<{ versionId: string; proposalId: string }>(
    '/onboarding/guided',
    session.accessToken,
    { threadId },
  );
  return { versionId: resp.versionId, proposalId: resp.proposalId };
}
