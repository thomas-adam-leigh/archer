import { useCallback, useState } from '@lynx-js/react';

import { AuthError, type Session, signIn, signUp } from '../lib/auth.js';

type Mode = 'signin' | 'signup';

export function AuthScreen(props: { onAuthed: (session: Session) => void }) {
  const { onAuthed } = props;
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = useCallback(() => {
    if (busy) return;
    setError(null);
    setNotice(null);

    if (!email.trim() || !password) {
      setError('Enter an email and password.');
      return;
    }

    setBusy(true);
    const run = async () => {
      if (mode === 'signin') {
        onAuthed(await signIn(email.trim(), password));
        return;
      }
      const { session } = await signUp(email.trim(), password);
      if (session) {
        onAuthed(session);
      } else {
        setNotice(
          'Account created — check your email to confirm, then sign in.',
        );
        setMode('signin');
      }
    };
    run()
      .catch((err: unknown) => {
        setError(
          err instanceof AuthError ? err.message : 'Something went wrong.',
        );
      })
      .finally(() => setBusy(false));
  }, [busy, email, password, mode, onAuthed]);

  const toggleMode = useCallback(() => {
    setMode((prev) => (prev === 'signin' ? 'signup' : 'signin'));
    setError(null);
    setNotice(null);
  }, []);

  const isSignin = mode === 'signin';

  return (
    <view className="Auth">
      <view className="Auth__card">
        <text className="Auth__title">
          {isSignin ? 'Welcome back' : 'Create account'}
        </text>
        <text className="Auth__subtitle">
          {isSignin ? 'Sign in to continue' : 'Sign up to get started'}
        </text>

        <input
          className="Field"
          type="email"
          placeholder="Email"
          bindinput={(e) => setEmail(e.detail.value)}
        />
        <input
          className="Field"
          type="password"
          placeholder="Password"
          bindinput={(e) => setPassword(e.detail.value)}
        />

        {error ? <text className="Auth__error">{error}</text> : null}
        {notice ? <text className="Auth__notice">{notice}</text> : null}

        <view
          className={busy ? 'Button Button--busy' : 'Button'}
          bindtap={submit}
        >
          <text className="Button__label">
            {busy ? 'Please wait…' : isSignin ? 'Sign in' : 'Sign up'}
          </text>
        </view>

        <view className="Auth__switch" bindtap={toggleMode}>
          <text className="Auth__switchText">
            {isSignin
              ? "Don't have an account? Sign up"
              : 'Already have an account? Sign in'}
          </text>
        </view>
      </view>
    </view>
  );
}
