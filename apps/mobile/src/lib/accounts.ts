/**
 * Acceptance-Gate account state + onboarding completion (ARC-81).
 *
 * Once the candidate has approved their profile and titles and captured a rule-out,
 * `POST /onboarding/complete` submits the account for the owner's Acceptance Gate
 * (readiness-checked server-side, ARC-69) — moving it out of `onboarding` and
 * landing the user on home. The home empty-state then reflects the gate state read
 * from `GET /accounts/state`: `submitted`/`under_review` → "Archer is reviewing your
 * profile" → `accepted` → "Archer is searching…".
 *
 * Both seams are injectable so the suite runs fully offline. The user is scoped via
 * the documented `user` query / `userId` body contract on top of the bearer token.
 */

import { apiGet, apiPost } from './api.js';
import type { Session } from './auth.js';

/** The Acceptance-Gate account status (mirrors the backend `account_status`). */
export type AccountStatus =
  | 'onboarding'
  | 'submitted'
  | 'under_review'
  | 'accepted'
  | 'rejected';

/** The GET surface the state read needs — injectable so it can be tested offline. */
export type AccountGet = <T>(path: string, accessToken: string) => Promise<T>;

/** The POST surface completion needs — injectable so it can be tested offline. */
export type AccountPost = <T>(
  path: string,
  accessToken: string,
  body?: unknown,
) => Promise<T>;

interface AccountStatusResponse {
  user: string;
  status: AccountStatus;
}

/** Read the user's Acceptance-Gate account status (defaults to `onboarding`). */
export async function fetchAccountState(
  session: Session,
  get: AccountGet = apiGet,
): Promise<AccountStatus> {
  const resp = await get<AccountStatusResponse>(
    `/accounts/state?user=${encodeURIComponent(session.user.id)}`,
    session.accessToken,
  );
  return resp.status;
}

/**
 * Finalize onboarding: submit the account for the Acceptance Gate. Returns the
 * resulting status (`submitted`). Throws (409 via `ApiError`) if the server's
 * readiness check is unmet — the router only calls this from the `submitting`
 * step, where readiness is already satisfied.
 */
export async function completeOnboarding(
  session: Session,
  post: AccountPost = apiPost,
): Promise<AccountStatus> {
  const resp = await post<AccountStatusResponse>(
    '/onboarding/complete',
    session.accessToken,
    { userId: session.user.id },
  );
  return resp.status;
}
