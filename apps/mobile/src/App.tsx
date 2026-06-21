import { useCallback, useState } from '@lynx-js/react';

import './App.css';
import { AuthScreen } from './components/AuthScreen.js';
import { HomeScreen } from './components/HomeScreen.js';
import type { Session } from './lib/auth.js';

export function App() {
  const [session, setSession] = useState<Session | null>(null);

  const onLogout = useCallback(() => setSession(null), []);

  return (
    <view className="Root">
      <view className="Background" />
      {session ? (
        <HomeScreen session={session} onLogout={onLogout} />
      ) : (
        <AuthScreen onAuthed={setSession} />
      )}
    </view>
  );
}
