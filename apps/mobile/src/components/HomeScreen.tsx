import { useCallback, useEffect, useState } from '@lynx-js/react';

import {
  type AccountStatus,
  fetchAccountState as fetchAccountStateDefault,
} from '../lib/accounts.js';
import { type Session, signOut } from '../lib/auth.js';

/**
 * Home empty-state copy per Acceptance-Gate status (ARC-81). Onboarding is already
 * complete here, so these reflect the gate: in review until the owner accepts, then
 * searching. No opportunities are shown — the search runs server-side only once the
 * account is `accepted`.
 */
const STATUS_COPY: Record<AccountStatus, { title: string; subtitle: string }> =
  {
    onboarding: {
      title: 'Finishing up…',
      subtitle: 'Just a moment while Archer gets you set up.',
    },
    submitted: {
      title: 'Archer is reviewing your profile',
      subtitle:
        "You're all set. Archer will start searching for opportunities once you're accepted.",
    },
    under_review: {
      title: 'Archer is reviewing your profile',
      subtitle:
        "You're all set. Archer will start searching for opportunities once you're accepted.",
    },
    accepted: {
      title: 'Archer is searching for opportunities…',
      subtitle:
        "You're accepted. Archer is looking for roles that fit — check back soon.",
    },
    rejected: {
      title: "Your profile wasn't accepted",
      subtitle:
        'Archer has paused your search for now. Reach out if you think this is a mistake.',
    },
  };

type Status =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; status: AccountStatus };

/**
 * The home screen the user lands on once onboarding completes (ARC-81). It reads
 * the account's Acceptance-Gate status and renders the matching empty-state — "in
 * review" until accepted, then "searching" — with a sign-out. The account read is
 * injectable so the suite runs offline.
 */
export function HomeScreen(props: {
  session: Session;
  onLogout: () => void;
  fetchAccountState?: typeof fetchAccountStateDefault;
}) {
  const { session, onLogout } = props;
  const fetchAccountState = props.fetchAccountState ?? fetchAccountStateDefault;
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setStatus({ kind: 'loading' });
    fetchAccountState(session)
      .then((s) => setStatus({ kind: 'ready', status: s }))
      .catch(() => setStatus({ kind: 'error' }));
  }, [session, fetchAccountState]);

  useEffect(load, [load]);

  const logout = useCallback(() => {
    if (busy) return;
    setBusy(true);
    // Revoke the token server-side, then clear local state regardless.
    signOut(session.accessToken).finally(() => {
      setBusy(false);
      onLogout();
    });
  }, [busy, session.accessToken, onLogout]);

  const copy =
    status.kind === 'ready'
      ? STATUS_COPY[status.status]
      : status.kind === 'loading'
        ? { title: 'One moment…', subtitle: 'Loading your status.' }
        : {
            title: 'Something went wrong',
            subtitle: "We couldn't load your status. Please try again.",
          };

  return (
    <view className="Auth">
      <view className="Auth__card">
        <text className="Auth__title">{copy.title}</text>
        <text className="Auth__subtitle">{copy.subtitle}</text>

        {status.kind === 'error' ? (
          <view className="Button" bindtap={load}>
            <text className="Button__label">Try again</text>
          </view>
        ) : null}

        <view className="Auth__switch" bindtap={logout}>
          <text className="Auth__switchText">
            {busy ? 'Signing out…' : 'Log out'}
          </text>
        </view>
      </view>
    </view>
  );
}
