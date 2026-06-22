import { useCallback, useEffect, useState } from '@lynx-js/react';

import type { Session } from '../lib/auth.js';
import {
  approveProposedDraft as approveProposedDraftDefault,
  type Certification,
  type Course,
  type Education,
  fetchProposedProfileDraft,
  NoProposedVersionError,
  type ProfileDraft,
  type ProfileFetch,
  type Project,
  type RevisionStarted,
  reviseProposedDraft as reviseProposedDraftDefault,
  type Skill,
  type WorkExperience,
} from '../lib/profile.js';
import { fetchPrimaryThreadId } from '../lib/threads.js';
import {
  captureVoice as captureVoiceDefault,
  VoiceInputError,
} from '../lib/voice.js';
import { StageScreen } from './StageScreen.js';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Format a `YYYY-MM-DD` date as `Mon YYYY`; pass anything else through unchanged. */
function formatDate(d?: string | null): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  return `${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1]}`.trim();
}

/** A `start – end` range, with `Present` for a current role and graceful gaps. */
function dateRange(
  start?: string | null,
  end?: string | null,
  isCurrent?: boolean | null,
): string | null {
  const s = formatDate(start);
  const e = isCurrent ? 'Present' : formatDate(end);
  if (s && e) return `${s} – ${e}`;
  return s ?? e ?? null;
}

/** Join the present (non-empty) parts of a meta line with a middot. */
function meta(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => !!p && p.length > 0);
  return kept.length > 0 ? kept.join(' · ') : null;
}

/** A titled résumé section; renders nothing when it has no items. */
function Section(props: { title: string; children: unknown }) {
  return (
    <view className="Resume__section">
      <text className="Resume__sectionTitle">{props.title}</text>
      {props.children as never}
    </view>
  );
}

/** One résumé entry: a bold title, an optional meta line, an optional body. */
function Item(props: {
  title: string;
  meta?: string | null;
  body?: string | null;
}) {
  return (
    <view className="Resume__item">
      <text className="Resume__itemTitle">{props.title}</text>
      {props.meta ? (
        <text className="Resume__itemMeta">{props.meta}</text>
      ) : null}
      {props.body ? (
        <text className="Resume__itemBody">{props.body}</text>
      ) : null}
    </view>
  );
}

type Status =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error' }
  | { kind: 'ready'; draft: ProfileDraft };

/**
 * The profile review screen (ARC-76 render + ARC-77 decision loop): a résumé-style
 * render of the PROPOSED profile version Archer assembled, the shared destination
 * for both onboarding paths. It reads the proposed version's `attributes` + spine
 * and lays out full name, contact, links, summary, experience, education, skills,
 * certifications, courses, and projects — each section omitted gracefully when empty.
 *
 * Beneath the résumé sit the decision actions (ARC-77): **Approve** self-approves
 * the candidate's own draft (`proposalId` resolved from `/onboarding/progress`) and
 * advances to job preferences; **feedback** (by text or voice) kicks off a streamed
 * revise run that amends the draft live and loops back to a fresh review. Every
 * network + voice seam is injectable so the suite runs fully offline.
 */
export function ProfileReviewScreen(props: {
  session: Session;
  /** The open proposal to self-approve (from progress); approve is disabled when null. */
  proposalId?: string | null;
  /** Advance past review once the draft is approved. */
  onApproved?: () => void;
  /** Hand the started revise run up so the live processing state can be shown. */
  onRevised?: (run: RevisionStarted) => void;
  fetchDraft?: (session: Session, get?: ProfileFetch) => Promise<ProfileDraft>;
  approve?: typeof approveProposedDraftDefault;
  revise?: typeof reviseProposedDraftDefault;
  resolveThreadId?: (session: Session) => Promise<string>;
  captureVoice?: typeof captureVoiceDefault;
}) {
  const { session, proposalId, onApproved, onRevised } = props;
  const approve = props.approve ?? approveProposedDraftDefault;
  const revise = props.revise ?? reviseProposedDraftDefault;
  const resolveThreadId = props.resolveThreadId ?? fetchPrimaryThreadId;
  const captureVoice = props.captureVoice ?? captureVoiceDefault;

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setStatus({ kind: 'loading' });
    const fetchDraft = props.fetchDraft ?? fetchProposedProfileDraft;
    fetchDraft(session)
      .then((draft) => setStatus({ kind: 'ready', draft }))
      .catch((err) =>
        setStatus(
          err instanceof NoProposedVersionError
            ? { kind: 'empty' }
            : { kind: 'error' },
        ),
      );
  }, [session, props.fetchDraft]);

  useEffect(load, [load]);

  // Self-approve the open draft and advance. Disabled until the proposal id resolves.
  const onApprove = useCallback(() => {
    if (busy || !proposalId) return;
    setBusy(true);
    setError(null);
    approve(session, proposalId)
      .then(() => onApproved?.())
      .catch(() => setError("Couldn't approve your profile. Please try again."))
      .finally(() => setBusy(false));
  }, [busy, proposalId, approve, session, onApproved]);

  // Submit feedback → start a revise run → hand it up for the live processing state.
  const submitFeedback = useCallback(
    (text: string) => {
      const instruction = text.trim();
      if (!instruction || busy) return;
      setBusy(true);
      setError(null);
      resolveThreadId(session)
        .then((threadId) =>
          revise(session, { threadId, feedback: instruction }),
        )
        .then((run) => {
          setFeedback('');
          onRevised?.(run);
        })
        .catch(() =>
          setError("Couldn't send your feedback to Archer. Please try again."),
        )
        .finally(() => setBusy(false));
    },
    [busy, resolveThreadId, session, revise, onRevised],
  );

  // Capture spoken feedback and submit it as a revise instruction.
  const submitVoiceFeedback = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    captureVoice({ accessToken: session.accessToken })
      .then((transcript) => {
        setBusy(false);
        submitFeedback(transcript);
      })
      .catch((err) => {
        setError(
          err instanceof VoiceInputError
            ? err.message
            : "Couldn't capture your voice. Please try again.",
        );
        setBusy(false);
      });
  }, [busy, captureVoice, session.accessToken, submitFeedback]);

  if (status.kind === 'loading') {
    return (
      <StageScreen
        title="Putting your profile together…"
        subtitle="Loading the draft Archer prepared."
      />
    );
  }

  if (status.kind === 'empty') {
    return (
      <StageScreen
        title="Nothing to review yet"
        subtitle="There's no profile draft waiting for you right now."
      />
    );
  }

  if (status.kind === 'error') {
    return (
      <StageScreen
        title="Couldn't load your profile"
        subtitle="Something went wrong loading your draft. Please try again."
        primaryLabel="Try again"
        onPrimary={load}
      />
    );
  }

  const { version, spine } = status.draft;
  const attrs = version.attributes ?? {};
  const links = attrs.links ?? {};

  const contact = meta(attrs.email, attrs.phone);
  const name = attrs.full_name?.trim() || 'Your profile';

  return (
    <scroll-view className="Resume" scroll-orientation="vertical">
      <view className="Resume__inner">
        <view className="Resume__header">
          <text className="Resume__name">{name}</text>
          {attrs.location ? (
            <text className="Resume__location">{attrs.location}</text>
          ) : null}
          {contact ? <text className="Resume__contact">{contact}</text> : null}
          {links.linkedin ? (
            <text className="Resume__link">{links.linkedin}</text>
          ) : null}
          {links.github ? (
            <text className="Resume__link">{links.github}</text>
          ) : null}
          {links.website ? (
            <text className="Resume__link">{links.website}</text>
          ) : null}
        </view>

        {attrs.summary ? (
          <Section title="Summary">
            <text className="Resume__summary">{attrs.summary}</text>
          </Section>
        ) : null}

        {spine.workExperiences?.length ? (
          <Section title="Experience">
            {spine.workExperiences.map((w: WorkExperience, i) => (
              <Item
                key={`work-${i}`}
                title={w.title}
                meta={meta(
                  w.organization,
                  w.location,
                  dateRange(w.startDate, w.endDate, w.isCurrent),
                )}
                body={w.description}
              />
            ))}
          </Section>
        ) : null}

        {spine.education?.length ? (
          <Section title="Education">
            {spine.education.map((e: Education, i) => (
              <Item
                key={`edu-${i}`}
                title={e.institution}
                meta={meta(
                  e.degree,
                  e.fieldOfStudy,
                  e.grade,
                  dateRange(e.startDate, e.endDate),
                )}
              />
            ))}
          </Section>
        ) : null}

        {spine.skills?.length ? (
          <Section title="Skills">
            <view className="Resume__chips">
              {spine.skills.map((s: Skill, i) => (
                <view key={`skill-${i}`} className="Resume__chip">
                  <text className="Resume__chipText">{s.name}</text>
                </view>
              ))}
            </view>
          </Section>
        ) : null}

        {spine.certifications?.length ? (
          <Section title="Certifications">
            {spine.certifications.map((c: Certification, i) => (
              <Item
                key={`cert-${i}`}
                title={c.name}
                meta={meta(c.issuer, formatDate(c.issuedOn))}
              />
            ))}
          </Section>
        ) : null}

        {spine.courses?.length ? (
          <Section title="Courses">
            {spine.courses.map((c: Course, i) => (
              <Item
                key={`course-${i}`}
                title={c.name}
                meta={meta(c.provider, formatDate(c.completedOn))}
              />
            ))}
          </Section>
        ) : null}

        {spine.projects?.length ? (
          <Section title="Projects">
            {spine.projects.map((p: Project, i) => (
              <Item
                key={`project-${i}`}
                title={p.name}
                meta={meta(p.role, dateRange(p.startDate, p.endDate))}
                body={p.description}
              />
            ))}
          </Section>
        ) : null}

        <view className="Resume__section">
          <text className="Resume__sectionTitle">Make it yours</text>
          <text className="Resume__itemBody">
            Approve to continue, or tell Archer what to add, change, or improve.
          </text>
          <input
            className="Field"
            placeholder="e.g. add my 2023 promotion, drop the summary"
            bindinput={(e) => setFeedback(e.detail.value)}
          />
          <view
            className={
              busy
                ? 'Button Button--secondary Button--busy'
                : 'Button Button--secondary'
            }
            bindtap={() => submitFeedback(feedback)}
          >
            <text className="Button__label">Send to Archer</text>
          </view>
          <view
            className={
              busy
                ? 'Button Button--secondary Button--busy'
                : 'Button Button--secondary'
            }
            bindtap={submitVoiceFeedback}
          >
            <text className="Button__label">🎤 Feedback by voice</text>
          </view>

          {error ? <text className="Auth__error">{error}</text> : null}

          <view
            className={busy || !proposalId ? 'Button Button--busy' : 'Button'}
            bindtap={onApprove}
          >
            <text className="Button__label">Approve &amp; continue</text>
          </view>
        </view>
      </view>
    </scroll-view>
  );
}
