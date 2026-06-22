import { useCallback, useEffect, useState } from '@lynx-js/react';

import type { Session } from '../lib/auth.js';
import {
  fetchOnboardingProgress,
  type OnboardingStep,
} from '../lib/onboarding.js';
import { HomeScreen } from './HomeScreen.js';
import { IntroScreen, type OnboardingPath } from './IntroScreen.js';
import { StageScreen } from './StageScreen.js';

/** The label + blurb shown for a resumed step whose screen lands in a later
 *  milestone. Replaced by the real screen as each issue ships. */
const RESUME_COPY: Record<
  Exclude<OnboardingStep, 'intro' | 'done'>,
  { title: string; subtitle: string }
> = {
  processing: {
    title: 'Building your profile',
    subtitle: 'Archer is still working through your résumé. Hang tight.',
  },
  review: {
    title: 'Your draft is ready',
    subtitle: 'Pick up reviewing the profile Archer put together.',
  },
  titles: {
    title: 'Choosing your target roles',
    subtitle: 'Pick up approving the job titles Archer suggested.',
  },
  submitting: {
    title: 'Submitting your profile',
    subtitle: "You're all set — Archer is sending your profile for review.",
  },
};

/** Copy for the chosen-path stand-in, until each path's flow exists. */
const PATH_COPY: Record<OnboardingPath, { title: string; subtitle: string }> = {
  resume: {
    title: 'Upload my résumé',
    subtitle: "Résumé upload is coming soon — we'll pick this up here.",
  },
  scratch: {
    title: 'Start from scratch',
    subtitle: "The guided chat is coming soon — we'll pick this up here.",
  },
};

type Status =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; step: OnboardingStep };

/**
 * The launch-time onboarding router (ARC-73). After auth it reads the resumable
 * onboarding step and restores exactly where the user left off: a brand-new user
 * lands on the intro; a returning user resumes at their step; a completed user
 * goes home. Replaces the old `session ? Home : Auth` toggle.
 */
export function OnboardingRouter(props: {
  session: Session;
  onLogout: () => void;
}) {
  const { session, onLogout } = props;
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [path, setPath] = useState<OnboardingPath | null>(null);

  const load = useCallback(() => {
    setStatus({ kind: 'loading' });
    fetchOnboardingProgress(session)
      .then((p) => setStatus({ kind: 'ready', step: p.step }))
      .catch(() => setStatus({ kind: 'error' }));
  }, [session]);

  useEffect(load, [load]);

  if (status.kind === 'loading') {
    return (
      <StageScreen title="One moment…" subtitle="Loading where you left off." />
    );
  }

  if (status.kind === 'error') {
    return (
      <StageScreen
        title="Something went wrong"
        subtitle="We couldn't load your progress. Please try again."
        primaryLabel="Try again"
        onPrimary={load}
        secondaryLabel="Sign out"
        onSecondary={onLogout}
      />
    );
  }

  if (status.step === 'done') {
    return <HomeScreen session={session} onLogout={onLogout} />;
  }

  if (status.step === 'intro') {
    // A chosen path leads to its flow (built in ARC-74 / ARC-80); until then,
    // show a stand-in the user can back out of so both paths stay reachable.
    if (path) {
      return (
        <StageScreen
          title={PATH_COPY[path].title}
          subtitle={PATH_COPY[path].subtitle}
          secondaryLabel="Back"
          onSecondary={() => setPath(null)}
        />
      );
    }
    return (
      <IntroScreen
        session={session}
        onChoosePath={setPath}
        onLogout={onLogout}
      />
    );
  }

  const copy = RESUME_COPY[status.step];
  return (
    <StageScreen
      title={copy.title}
      subtitle={copy.subtitle}
      secondaryLabel="Sign out"
      onSecondary={onLogout}
    />
  );
}
