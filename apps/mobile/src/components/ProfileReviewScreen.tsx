import { useCallback, useEffect, useState } from '@lynx-js/react';

import type { Session } from '../lib/auth.js';
import {
  type Certification,
  type Course,
  type Education,
  fetchProposedProfileDraft,
  NoProposedVersionError,
  type ProfileDraft,
  type ProfileFetch,
  type Project,
  type Skill,
  type WorkExperience,
} from '../lib/profile.js';
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
 * The profile review screen (ARC-76): a résumé-style render of the PROPOSED
 * profile version Archer assembled, the shared destination for both onboarding
 * paths. It reads the proposed version's `attributes` + spine and lays out full
 * name, contact, links, summary, experience, education, skills, certifications,
 * courses, and projects — each section omitted gracefully when empty.
 *
 * This screen is read-only; the approve / feedback / redraft actions land beneath
 * it in ARC-77. The fetch is injectable so the suite runs fully offline.
 */
export function ProfileReviewScreen(props: {
  session: Session;
  fetchDraft?: (session: Session, get?: ProfileFetch) => Promise<ProfileDraft>;
}) {
  const { session } = props;
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

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
      </view>
    </scroll-view>
  );
}
