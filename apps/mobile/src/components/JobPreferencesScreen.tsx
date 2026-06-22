import { useCallback, useEffect, useState } from '@lynx-js/react';

import type { Session } from '../lib/auth.js';
import {
  addNegativeCriterion as addNegativeCriterionDefault,
  approveTitles as approveTitlesDefault,
  suggestTitles as suggestTitlesDefault,
} from '../lib/preferences.js';
import {
  captureVoice as captureVoiceDefault,
  VoiceInputError,
} from '../lib/voice.js';

type Status =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; titles: string[] };

/**
 * The job-preferences screen (ARC-78): approve Archer's suggested target titles
 * (and capture a rule-out) before completing onboarding.
 *
 * On open it asks the backend for ~5 ranked titles from the approved profile and
 * renders them. The candidate can give feedback by text or voice to re-rank/refine
 * — a live re-suggest the screen loops until they approve, which persists the 1–5
 * titles to `target_titles`. They also capture ≥1 negative criterion (a deal-
 * breaker) so the account can pass the Acceptance-Gate readiness check; approval
 * is gated on at least one being saved.
 *
 * Every network + voice seam is injectable so the suite runs fully offline.
 */
export function JobPreferencesScreen(props: {
  session: Session;
  /** Advance to completion once titles are approved (and a rule-out is saved). */
  onApproved: () => void;
  suggest?: typeof suggestTitlesDefault;
  approve?: typeof approveTitlesDefault;
  addCriterion?: typeof addNegativeCriterionDefault;
  captureVoice?: typeof captureVoiceDefault;
}) {
  const { session, onApproved } = props;
  const suggest = props.suggest ?? suggestTitlesDefault;
  const approve = props.approve ?? approveTitlesDefault;
  const addCriterion = props.addCriterion ?? addNegativeCriterionDefault;
  const captureVoice = props.captureVoice ?? captureVoiceDefault;

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [feedback, setFeedback] = useState('');
  const [ruleOut, setRuleOut] = useState('');
  const [criteria, setCriteria] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titles = status.kind === 'ready' ? status.titles : [];

  const load = useCallback(() => {
    setStatus({ kind: 'loading' });
    setError(null);
    suggest(session, {})
      .then((next) => setStatus({ kind: 'ready', titles: next }))
      .catch(() => setStatus({ kind: 'error' }));
  }, [session, suggest]);

  useEffect(load, [load]);

  // Re-suggest from feedback, keeping the current list as context to re-rank.
  const reSuggest = useCallback(
    (text: string) => {
      const instruction = text.trim();
      if (!instruction || busy) return;
      setBusy(true);
      setError(null);
      suggest(session, { feedback: instruction, current: titles })
        .then((next) => {
          setStatus({ kind: 'ready', titles: next });
          setFeedback('');
        })
        .catch(() => setError("Couldn't refine the titles. Please try again."))
        .finally(() => setBusy(false));
    },
    [session, suggest, titles, busy],
  );

  const captureRuleOutOrFeedback = useCallback(
    (apply: (transcript: string) => void) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      captureVoice({ accessToken: session.accessToken })
        .then(apply)
        .catch((err) =>
          setError(
            err instanceof VoiceInputError
              ? err.message
              : "Couldn't capture your voice. Please try again.",
          ),
        )
        .finally(() => setBusy(false));
    },
    [busy, captureVoice, session.accessToken],
  );

  const saveCriterion = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value || busy) return;
      setBusy(true);
      setError(null);
      addCriterion(session, value)
        .then((saved) => {
          setCriteria((prev) => [...prev, saved.text ?? value]);
          setRuleOut('');
        })
        .catch(() => setError("Couldn't save that rule-out. Please try again."))
        .finally(() => setBusy(false));
    },
    [session, addCriterion, busy],
  );

  const onApprove = useCallback(() => {
    if (busy || titles.length === 0 || criteria.length === 0) return;
    setBusy(true);
    setError(null);
    approve(session, titles)
      .then(() => onApproved())
      .catch(() => setError("Couldn't save your titles. Please try again."))
      .finally(() => setBusy(false));
  }, [busy, titles, criteria.length, approve, session, onApproved]);

  if (status.kind === 'loading') {
    return (
      <view className="Auth">
        <view className="Auth__card">
          <text className="Auth__title">Choosing your target roles</text>
          <text className="Auth__subtitle">
            Archer is lining up the roles to search for you.
          </text>
        </view>
      </view>
    );
  }

  if (status.kind === 'error') {
    return (
      <view className="Auth">
        <view className="Auth__card">
          <text className="Auth__title">Couldn't suggest titles</text>
          <text className="Auth__subtitle">
            Something went wrong choosing your target roles. Please try again.
          </text>
          <view className="Button" bindtap={load}>
            <text className="Button__label">Try again</text>
          </view>
        </view>
      </view>
    );
  }

  const canApprove = titles.length > 0 && criteria.length > 0 && !busy;

  return (
    <scroll-view className="Resume" scroll-orientation="vertical">
      <view className="Resume__inner">
        <view className="Resume__header">
          <text className="Resume__name">Your target roles</text>
          <text className="Resume__contact">
            Here's what Archer will search for. Approve them, or tell Archer how
            to re-rank or change them.
          </text>
        </view>

        <view className="Resume__section">
          <text className="Resume__sectionTitle">Suggested titles</text>
          {titles.map((title, i) => (
            <view key={`title-${i}`} className="Resume__item">
              <text className="Resume__itemTitle">{`${i + 1}. ${title}`}</text>
            </view>
          ))}
        </view>

        <view className="Resume__section">
          <text className="Resume__sectionTitle">Refine</text>
          <input
            className="Field"
            placeholder="e.g. put TypeScript Developer first"
            bindinput={(e) => setFeedback(e.detail.value)}
          />
          <view
            className={busy ? 'Button Button--busy' : 'Button'}
            bindtap={() => reSuggest(feedback)}
          >
            <text className="Button__label">Re-rank these</text>
          </view>
          <view
            className="Button Button--secondary"
            bindtap={() => captureRuleOutOrFeedback(reSuggest)}
          >
            <text className="Button__label">🎤 Refine by voice</text>
          </view>
        </view>

        <view className="Resume__section">
          <text className="Resume__sectionTitle">Anything you'd rule out?</text>
          {criteria.length > 0 ? (
            <view className="Resume__chips">
              {criteria.map((c, i) => (
                <view key={`crit-${i}`} className="Resume__chip">
                  <text className="Resume__chipText">{c}</text>
                </view>
              ))}
            </view>
          ) : null}
          <input
            className="Field"
            placeholder="e.g. no on-site only, no crypto"
            bindinput={(e) => setRuleOut(e.detail.value)}
          />
          <view
            className="Button Button--secondary"
            bindtap={() => saveCriterion(ruleOut)}
          >
            <text className="Button__label">Add rule-out</text>
          </view>
          <view
            className="Button Button--secondary"
            bindtap={() => captureRuleOutOrFeedback(saveCriterion)}
          >
            <text className="Button__label">🎤 Add by voice</text>
          </view>
        </view>

        {error ? <text className="Auth__error">{error}</text> : null}
        {criteria.length === 0 ? (
          <text className="Auth__subtitle">
            Add at least one thing you'd rule out to continue.
          </text>
        ) : null}

        <view
          className={canApprove ? 'Button' : 'Button Button--busy'}
          bindtap={onApprove}
        >
          <text className="Button__label">Approve &amp; continue</text>
        </view>
      </view>
    </scroll-view>
  );
}
