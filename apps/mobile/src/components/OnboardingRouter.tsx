import { useCallback, useEffect, useState } from '@lynx-js/react';

import type { Session } from '../lib/auth.js';
import {
  fetchOnboardingProgress,
  type OnboardingStep,
} from '../lib/onboarding.js';
import type { RevisionStarted } from '../lib/profile.js';
import type { IngestStarted } from '../lib/resume.js';
import { fetchPrimaryThreadId } from '../lib/threads.js';
import { CompletionScreen } from './CompletionScreen.js';
import { ConversationalOnboardingScreen } from './ConversationalOnboardingScreen.js';
import { HomeScreen } from './HomeScreen.js';
import { IntroScreen, type OnboardingPath } from './IntroScreen.js';
import { JobPreferencesScreen } from './JobPreferencesScreen.js';
import { ProcessingScreen, REVISE_PHASES } from './ProcessingScreen.js';
import { ProfileReviewScreen } from './ProfileReviewScreen.js';
import { ResumeUploadScreen } from './ResumeUploadScreen.js';
import { StageScreen } from './StageScreen.js';

/** The label + blurb shown for a resumed step whose screen lands in a later
 *  milestone. Replaced by the real screen as each issue ships. */
const RESUME_COPY: Record<
  Exclude<
    OnboardingStep,
    'intro' | 'review' | 'titles' | 'submitting' | 'done'
  >,
  { title: string; subtitle: string }
> = {
  processing: {
    title: 'Building your profile',
    subtitle: 'Archer is still working through your résumé. Hang tight.',
  },
};

type Status =
  | { kind: 'loading' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      step: OnboardingStep;
      proposalId: string | null;
      /** The thread to reattach the processing screen to on a cold restart
       *  (ARC-82) — resolved only for the `processing` step, null otherwise (or
       *  when resolution failed, in which case we fall back to the stand-in). */
      threadId: string | null;
    };

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
  const [reviseRun, setReviseRun] = useState<RevisionStarted | null>(null);

  const load = useCallback(() => {
    setStatus({ kind: 'loading' });
    fetchOnboardingProgress(session)
      .then(async (p) => {
        // On a cold restart mid-ingest the run lives only on the server; resolve
        // the user's thread so the processing screen can reattach to it via
        // history + Realtime (ARC-82). Failing to resolve is non-fatal — the
        // processing branch falls back to a static stand-in.
        const threadId =
          p.step === 'processing'
            ? await fetchPrimaryThreadId(session).catch(() => null)
            : null;
        setStatus({
          kind: 'ready',
          step: p.step,
          proposalId: p.openProposalId,
          threadId,
        });
      })
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
    // The start-from-scratch path (ARC-80): a guided chat that accretes the same
    // structured draft and converges on the shared review. On completion we re-read
    // progress, which moves the user to the review step.
    if (path === 'scratch') {
      return (
        <ConversationalOnboardingScreen
          session={session}
          onComplete={load}
          onBack={() => setPath(null)}
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

  // The proposed-draft review (ARC-76 + ARC-77): reached when the ingest run lands
  // a proposed version, and on relaunch for a user who left off at review. The
  // screen resolves the proposed version itself, so no id needs threading. Approve
  // self-approves and advances (re-read progress → titles); feedback starts a revise
  // run, which we render as a live processing state that loops back to a fresh review.
  if (status.step === 'review') {
    if (reviseRun) {
      return (
        <ProcessingScreen
          session={session}
          ingest={reviseRun}
          phases={REVISE_PHASES}
          failureMessage="Archer couldn't update your profile. Please try again."
          onComplete={() => {
            setReviseRun(null);
            load();
          }}
          onRetry={() => setReviseRun(null)}
        />
      );
    }
    return (
      <ProfileReviewScreen
        session={session}
        proposalId={status.proposalId}
        onApproved={load}
        onRevised={setReviseRun}
      />
    );
  }

  // The job-preferences step (ARC-78): approve Archer's suggested target titles
  // (re-rank by text/voice) and capture ≥1 rule-out, then advance. Reached after
  // profile approval, and on relaunch for a user who left off here. On approval we
  // re-read progress, which moves them on to submitting/done.
  if (status.step === 'titles') {
    return <JobPreferencesScreen session={session} onApproved={load} />;
  }

  // The completion step (ARC-81): profile + titles approved and a rule-out captured.
  // Submit the account for the Acceptance Gate, then re-read progress (→ done) to
  // land on the status-aware home. Reached after job-preferences approval, and on
  // relaunch for a user who left off here before the submit landed.
  if (status.step === 'submitting') {
    return <CompletionScreen session={session} onComplete={load} />;
  }

  // The processing step (ARC-82): a returning user who left off mid-ingest. The
  // run already streamed (or is streaming) server-side, so we reattach the real
  // processing screen to their thread — it seeds from history and follows
  // Realtime, then advances to review when the proposed version lands (re-read
  // progress). If the thread couldn't be resolved we fall back to the stand-in.
  if (status.step === 'processing' && status.threadId) {
    return (
      <ProcessingScreen
        session={session}
        ingest={{ threadId: status.threadId }}
        onComplete={load}
        onRetry={load}
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
