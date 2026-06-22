import { describe, expect, test, vi } from 'vitest';

vi.mock('./supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));

import type { Session } from './auth.js';
import {
  fetchPrimaryThreadId,
  THREADS_URL,
  ThreadLookupError,
} from './threads.js';

const session: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchPrimaryThreadId', () => {
  test('reads the earliest thread id with the JWT + apikey', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse([{ id: 'thread-9' }]),
    );

    const id = await fetchPrimaryThreadId(
      session,
      fetchImpl as unknown as typeof fetch,
    );

    expect(id).toBe('thread-9');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${THREADS_URL}?select=id&order=created_at.asc&limit=1`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-1');
    expect(headers.apikey).toBe('sb_publishable_test');
  });

  test('throws when no thread exists', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    await expect(
      fetchPrimaryThreadId(session, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(ThreadLookupError);
  });

  test('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'no' }, 403));
    await expect(
      fetchPrimaryThreadId(session, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(ThreadLookupError);
  });
});
