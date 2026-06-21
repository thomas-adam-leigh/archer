import { useCallback, useState } from '@lynx-js/react';

import { type Session, signOut } from '../lib/auth.js';

export function HomeScreen(props: { session: Session; onLogout: () => void }) {
  const { session, onLogout } = props;
  const [busy, setBusy] = useState(false);

  const logout = useCallback(() => {
    if (busy) return;
    setBusy(true);
    // Revoke the token server-side, then clear local state regardless.
    signOut(session.accessToken).finally(() => {
      setBusy(false);
      onLogout();
    });
  }, [busy, session.accessToken, onLogout]);

  return (
    <view className="Auth">
      <view className="Auth__card">
        <text className="Auth__title">You're signed in</text>
        <text className="Auth__subtitle">
          {session.user.email ?? session.user.id}
        </text>

        <view
          className={busy ? 'Button Button--busy' : 'Button'}
          bindtap={logout}
        >
          <text className="Button__label">
            {busy ? 'Signing out…' : 'Log out'}
          </text>
        </view>
      </view>
    </view>
  );
}
