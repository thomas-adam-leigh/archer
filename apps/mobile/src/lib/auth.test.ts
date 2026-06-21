import { afterEach, describe, expect, test, vi } from 'vitest';

import { AuthError, signIn, signOut, signUp } from './auth.js';

vi.mock('./supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));

const sessionBody = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mockFetch(response: { ok: boolean; json?: unknown; status?: number }) {
  const fn = vi.fn(async (_url: string, _init: FetchInit) => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.json,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('signIn', () => {
  test('posts credentials to the token endpoint and returns a session', async () => {
    const fetchMock = mockFetch({ ok: true, json: sessionBody });

    const session = await signIn('a@b.com', 'secret');

    expect(session).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      user: { id: 'user-1', email: 'a@b.com' },
    });
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      'https://example.supabase.co/auth/v1/token?grant_type=password',
    );
    expect(init.headers.apikey).toBe('sb_publishable_test');
    expect(JSON.parse(init.body ?? '{}')).toEqual({
      email: 'a@b.com',
      password: 'secret',
    });
  });

  test('throws an AuthError with the server message on failure', async () => {
    mockFetch({ ok: false, json: { msg: 'Invalid login credentials' } });

    await expect(signIn('a@b.com', 'wrong')).rejects.toThrow(AuthError);
    await expect(signIn('a@b.com', 'wrong')).rejects.toThrow(
      'Invalid login credentials',
    );
  });
});

describe('signUp', () => {
  test('returns a session when the server auto-confirms', async () => {
    mockFetch({ ok: true, json: sessionBody });

    const { session } = await signUp('a@b.com', 'secret');

    expect(session?.accessToken).toBe('access-1');
  });

  test('returns a null session when email confirmation is required', async () => {
    mockFetch({ ok: true, json: { id: 'user-1', email: 'a@b.com' } });

    const { session } = await signUp('a@b.com', 'secret');

    expect(session).toBeNull();
  });
});

describe('signOut', () => {
  test('revokes the token and never throws', async () => {
    const fetchMock = mockFetch({ ok: true, json: {} });

    await expect(signOut('access-1')).resolves.toBeUndefined();

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      'https://example.supabase.co/auth/v1/logout?scope=local',
    );
    expect(init.headers.Authorization).toBe('Bearer access-1');
  });

  test('swallows network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(signOut('access-1')).resolves.toBeUndefined();
  });
});
