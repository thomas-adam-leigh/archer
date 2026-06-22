import { describe, expect, test, vi } from 'vitest';

// Stub the API config so importing the module under test (→ api.js → config.js)
// doesn't require the client env. Every seam is injected below regardless.
vi.mock('./config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import {
  type AccountStatus,
  completeOnboarding,
  fetchAccountState,
} from './accounts.js';
import type { Session } from './auth.js';

const session: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

describe('fetchAccountState', () => {
  test('requests the user-scoped account-state path with the access token', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ user: 'user-1', status: 'submitted' });

    const status = await fetchAccountState(session, get);

    expect(get).toHaveBeenCalledWith('/accounts/state?user=user-1', 'access-1');
    expect(status).toBe<AccountStatus>('submitted');
  });

  test('url-encodes the user id', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ user: 'a/b c', status: 'accepted' });

    await fetchAccountState(
      { ...session, user: { id: 'a/b c', email: null } },
      get,
    );

    expect(get).toHaveBeenCalledWith(
      '/accounts/state?user=a%2Fb%20c',
      'access-1',
    );
  });
});

describe('completeOnboarding', () => {
  test('posts the user-scoped completion and returns the resulting status', async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ user: 'user-1', status: 'submitted' });

    const status = await completeOnboarding(session, post);

    expect(post).toHaveBeenCalledWith('/onboarding/complete', 'access-1', {
      userId: 'user-1',
    });
    expect(status).toBe<AccountStatus>('submitted');
  });

  test('propagates a readiness failure (the POST rejects)', async () => {
    const post = vi.fn().mockRejectedValue(new Error('onboarding incomplete'));

    await expect(completeOnboarding(session, post)).rejects.toThrow(
      'onboarding incomplete',
    );
  });
});
