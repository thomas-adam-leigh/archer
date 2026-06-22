import { describe, expect, test } from 'vitest';

import type { Session } from './auth.js';
import { clearSession, loadSession, saveSession } from './session-store.js';
import { createMemoryStorage } from './storage.js';

const session: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

describe('session-store', () => {
  test('persists and restores a session across a fresh store read', async () => {
    const store = createMemoryStorage();

    expect(await loadSession(store)).toBeNull();
    await saveSession(session, store);
    expect(await loadSession(store)).toEqual(session);
  });

  test('clearSession drops the persisted session', async () => {
    const store = createMemoryStorage();
    await saveSession(session, store);

    await clearSession(store);

    expect(await loadSession(store)).toBeNull();
  });

  test('returns null for a corrupt value', async () => {
    const store = createMemoryStorage();
    await store.setItem('archer.session', 'not json');

    expect(await loadSession(store)).toBeNull();
  });

  test('returns null for a well-formed value missing required fields', async () => {
    const store = createMemoryStorage();
    await store.setItem(
      'archer.session',
      JSON.stringify({ accessToken: 'x', user: {} }),
    );

    expect(await loadSession(store)).toBeNull();
  });
});
