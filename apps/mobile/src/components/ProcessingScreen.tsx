import { useEffect, useRef, useState } from '@lynx-js/react';

import {
  createThreadSession,
  type Json,
  type ThreadSession,
  type ThreadSessionOptions,
  type ThreadView,
} from '../lib/agui/index.js';
import type { Session } from '../lib/auth.js';
import type { IngestStarted } from '../lib/resume.js';

/** The proposed version an ingest run produced — handed to the review step (ARC-76). */
export interface IngestComplete {
  versionId: string;
  proposalId: string;
}

/**
 * The streamed ingest phases, in order, with their display copy. Mirrors the
 * backend `INGEST_PHASES` (`services/api/src/agui.ts`): the run flips
 * `state.phase` through `reading → extracting → building → complete`. The screen
 * renders against the live `state.phase`, never a fake timer.
 */
const PHASES = [
  { key: 'reading', label: 'Reading your résumé' },
  { key: 'extracting', label: 'Extracting your experience' },
  { key: 'building', label: 'Building your profile' },
] as const;

/** Lowercase the first letter so a phase label reads after "Archer is …". */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * The résumé processing screen (ARC-75): a full-screen, **non-interruptible**
 * state subscribed to the ingest run's `events` via the AG-UI/Realtime client.
 * It seeds from history, streams live, and renders the three ordered phases as
 * Archer works. When the proposed version lands (`state.phase === 'complete'`
 * with `versionId`/`proposalId`, or the run finishes successfully) it advances
 * to the profile review; a failed run shows a single retry.
 *
 * While running there is no cancel/back — the only action is retry, and only on
 * failure. The thread session is injectable so the suite runs fully offline.
 */
export function ProcessingScreen(props: {
  session: Session;
  ingest: IngestStarted;
  onComplete: (result: IngestComplete) => void;
  onRetry: () => void;
  createSession?: (opts: ThreadSessionOptions) => ThreadSession;
}) {
  const { session, ingest, onComplete, onRetry } = props;
  const [view, setView] = useState<ThreadView | null>(null);
  const notified = useRef(false);

  useEffect(() => {
    const factory = props.createSession ?? createThreadSession;
    const ts = factory({
      threadId: ingest.threadId,
      accessToken: session.accessToken,
      onChange: setView,
    });
    ts.subscribe();
    // Seed from persisted history; live Realtime inserts converge with it.
    ts.loadHistory()
      .then(setView)
      .catch(() => {
        // A failed seed is non-fatal: Realtime + the resolved view still drive
        // the screen. The run's own failure surfaces as `phase === 'error'`.
      });
    return () => ts.close();
  }, [ingest.threadId, session.accessToken, props.createSession]);

  const state = (view?.state ?? {}) as Record<string, Json>;
  const statePhase = typeof state.phase === 'string' ? state.phase : 'reading';
  const lifecycle = view?.phase ?? null;
  const versionId =
    typeof state.versionId === 'string' ? state.versionId : null;
  const proposalId =
    typeof state.proposalId === 'string' ? state.proposalId : null;
  const failed = lifecycle === 'error';
  const complete =
    (statePhase === 'complete' || lifecycle === 'completed') &&
    versionId !== null &&
    proposalId !== null;

  // Advance exactly once when the proposed version lands.
  useEffect(() => {
    if (notified.current) return;
    if (complete && versionId && proposalId) {
      notified.current = true;
      onComplete({ versionId, proposalId });
    }
  }, [complete, versionId, proposalId, onComplete]);

  if (failed) {
    return (
      <view className="Auth">
        <view className="Auth__card">
          <text className="Auth__title">Something went wrong</text>
          <text className="Auth__subtitle">
            Archer couldn't finish reading your résumé. Please try again.
          </text>
          <view className="Button" bindtap={onRetry}>
            <text className="Button__label">Try again</text>
          </view>
        </view>
      </view>
    );
  }

  // Map the live phase onto the ordered list: phases before it are done, the
  // current one is active, later ones pending. `complete` marks them all done.
  const activeIndex =
    statePhase === 'complete'
      ? PHASES.length
      : Math.max(
          0,
          PHASES.findIndex((p) => p.key === statePhase),
        );
  const heading = PHASES[Math.min(activeIndex, PHASES.length - 1)];
  const headingText = `Archer is ${lowerFirst(heading.label)}`;

  return (
    <view className="Auth">
      <view className="Auth__card">
        <text className="Auth__title">{headingText}</text>
        <text className="Auth__subtitle">
          Hang tight — this only takes a moment. There's nothing to do here.
        </text>

        {PHASES.map((p, i) => {
          const status =
            i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending';
          return (
            <view key={p.key} className={`Phase Phase--${status}`}>
              <text className="Phase__mark">
                {status === 'done' ? '✓' : '•'}
              </text>
              <text className="Phase__label">{p.label}</text>
            </view>
          );
        })}
      </view>
    </view>
  );
}
