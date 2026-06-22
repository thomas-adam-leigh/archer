/**
 * Persisting the signed-in session across app restarts.
 *
 * The session was previously held only in React state (`src/App.tsx`), so it
 * was lost whenever the app was killed. We now mirror it into persistent
 * storage on sign-in and restore it on launch, clearing it on sign-out.
 */

import type { Session } from './auth.js';
import { type PersistentStorage, storage } from './storage.js';

const SESSION_KEY = 'archer.session';

/** A value is a usable session only if it carries both tokens and a user id. */
function isSession(value: unknown): value is Session {
  const s = value as Session | null;
  return Boolean(
    s &&
      typeof s.accessToken === 'string' &&
      typeof s.refreshToken === 'string' &&
      typeof s.user?.id === 'string',
  );
}

/** Read the persisted session, or `null` if there is none / it is corrupt. */
export async function loadSession(
  store: PersistentStorage = storage,
): Promise<Session | null> {
  const raw = await store.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the session so it survives a full app restart. */
export async function saveSession(
  session: Session,
  store: PersistentStorage = storage,
): Promise<void> {
  await store.setItem(SESSION_KEY, JSON.stringify(session));
}

/** Drop the persisted session (called on sign-out). */
export async function clearSession(
  store: PersistentStorage = storage,
): Promise<void> {
  await store.removeItem(SESSION_KEY);
}
