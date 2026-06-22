import { useCallback, useEffect, useState } from '@lynx-js/react';

import './App.css';
import { AuthScreen } from './components/AuthScreen.js';
import { HomeScreen } from './components/HomeScreen.js';
import type { Session } from './lib/auth.js';
import { clearSession, loadSession, saveSession } from './lib/session-store.js';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(true);

  // Restore any persisted session on launch so the app survives a restart.
  useEffect(() => {
    loadSession()
      .then(setSession)
      .finally(() => setRestoring(false));
  }, []);

  const onAuthed = useCallback((next: Session) => {
    setSession(next);
    void saveSession(next);
  }, []);

  const onLogout = useCallback(() => {
    setSession(null);
    void clearSession();
  }, []);

  return (
    <view className="Root">
      <view className="Background" />
      {restoring ? null : session ? (
        <HomeScreen session={session} onLogout={onLogout} />
      ) : (
        <AuthScreen onAuthed={onAuthed} />
      )}
    </view>
  );
}
