import { useCallback, useEffect, useState } from '@lynx-js/react';

import type { Session } from '../lib/auth.js';
import {
  fetchOnboardingProgress,
  type OnboardingStep,
} from '../lib/onboarding.js';
import type { IngestStarted } from '../lib/resume.js';
import { HomeScreen } from './HomeScreen.js';
import { IntroScreen, type OnboardingPath } from './IntroScreen.js';
import { ProcessingScreen } from './ProcessingScreen.js';
import { ProfileReviewScreen } from './ProfileReviewScreen.js';
import { ResumeUploadScreen } from './ResumeUploadScreen.js';
import { StageScreen } from './StageScreen.js';

/** The label + blurb shown for a resumed step whose screen lands in a later
 *  milestone. Replaced by the real screen as each issue ships. */
const RESUME_COPY: Record<
  Exclude<OnboardingStep, 'intro' | 'review' | 'done'>,
  { title: string; subtitle: string }
> = {
  processing: {
    title: 'Building your profile',
    subtitle: 'Archer is still working through your résumé. Hang tight.',
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

/** Copy for the start-from-scratch stand-in, until the guided chat exists (ARC-80). */
const SCRATCH_COPY = {
  title: 'Start from scratch',
  subtitle: "The guided chat is coming soon — we'll pick this up here.",
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
  const [ingest, setIngest] = useState<IngestStarted | null>(null);

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
    // Once the résumé ingest run has started, hand off to the streamed, non-
    // interruptible processing screen (ARC-75). On completion it advances to the
    // review step; a failed run clears the run and returns to the upload screen.
    if (ingest) {
      return (
        <ProcessingScreen
          session={session}
          ingest={ingest}
          onComplete={() => {
            setIngest(null);
            load();
          }}
          onRetry={() => setIngest(null)}
        />
      );
    }
    // The résumé path: pick → upload → start ingest (ARC-74). The guided chat
    // (ARC-80) is still a stand-in. Both stay reachable via Back.
    if (path === 'resume') {
      return (
        <ResumeUploadScreen
          session={session}
          onIngestStarted={setIngest}
          onBack={() => setPath(null)}
        />
      );
    }
    if (path === 'scratch') {
      return (
        <StageScreen
          title={SCRATCH_COPY.title}
          subtitle={SCRATCH_COPY.subtitle}
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

  // The proposed-draft review (ARC-76): reached when the ingest run lands a
  // proposed version, and on relaunch for a user who left off at review. The
  // screen resolves the proposed version itself, so no id needs threading.
  if (status.step === 'review') {
    return <ProfileReviewScreen session={session} />;
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
