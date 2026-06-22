import { useCallback, useEffect, useRef, useState } from '@lynx-js/react';

import { completeOnboarding as completeOnboardingDefault } from '../lib/accounts.js';
import type { Session } from '../lib/auth.js';
import { StageScreen } from './StageScreen.js';

/**
 * The completion step (ARC-81): the candidate has approved their profile and titles
 * and captured a rule-out (step `submitting`). On mount this submits the account for
 * the owner's Acceptance Gate (`POST /onboarding/complete`) and, on success, hands
 * back to the router — which re-reads progress (now `done`) and lands the user on
 * the account-status-aware home. A failure offers a retry; the completion seam is
 * injectable so the suite runs offline.
 */
export function CompletionScreen(props: {
  session: Session;
  /** Re-read progress once the account is submitted (→ done → home). */
  onComplete: () => void;
  complete?: typeof completeOnboardingDefault;
}) {
  const { session, onComplete } = props;
  const complete = props.complete ?? completeOnboardingDefault;
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  const submit = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailed(false);
    complete(session)
      .then(() => onComplete())
      .catch(() => setFailed(true))
      .finally(() => {
        inFlight.current = false;
      });
  }, [session, complete, onComplete]);

  useEffect(submit, [submit]);

  if (failed) {
    return (
      <StageScreen
        title="Couldn't submit your profile"
        subtitle="Something went wrong sending your profile for review. Please try again."
        primaryLabel="Try again"
        onPrimary={submit}
      />
    );
  }

  return (
    <StageScreen
      title="Submitting your profile"
      subtitle="You're all set — Archer is sending your profile for review."
    />
  );
}
