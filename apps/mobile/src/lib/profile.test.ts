import { describe, expect, test, vi } from 'vitest';

// Stub the API config so importing the module under test (→ api.js → config.js)
// doesn't require the client env. The fetch is injected below regardless.
vi.mock('./config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import type { Session } from './auth.js';
import {
  fetchProposedProfileDraft,
  NoProposedVersionError,
} from './profile.js';

const session: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

describe('fetchProposedProfileDraft', () => {
  test('resolves the proposed version, then reads its detail (version + spine)', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        versions: [
          { id: 'v1', status: 'superseded', attributes: {} },
          { id: 'v2', status: 'proposed', attributes: { full_name: 'Ada' } },
        ],
        liveVersionId: null,
      })
      .mockResolvedValueOnce({
        version: {
          id: 'v2',
          status: 'proposed',
          attributes: { full_name: 'Ada' },
        },
        spine: { skills: [{ name: 'TypeScript' }] },
      });

    const draft = await fetchProposedProfileDraft(session, get);

    expect(get).toHaveBeenNthCalledWith(
      1,
      '/profile/versions?user=user-1',
      'access-1',
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      '/profile/versions/v2?user=user-1',
      'access-1',
    );
    expect(draft.version.id).toBe('v2');
    expect(draft.spine.skills).toEqual([{ name: 'TypeScript' }]);
  });

  test('throws NoProposedVersionError when nothing is awaiting review', async () => {
    const get = vi.fn().mockResolvedValueOnce({
      versions: [{ id: 'v1', status: 'approved', attributes: {} }],
      liveVersionId: 'v1',
    });

    await expect(
      fetchProposedProfileDraft(session, get),
    ).rejects.toBeInstanceOf(NoProposedVersionError);
    // It never reads a version detail when there's no proposed version.
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('defaults a missing spine to an empty object', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        versions: [{ id: 'v2', status: 'proposed', attributes: {} }],
        liveVersionId: null,
      })
      .mockResolvedValueOnce({
        version: { id: 'v2', status: 'proposed', attributes: {} },
      });

    const draft = await fetchProposedProfileDraft(session, get);
    expect(draft.spine).toEqual({});
  });

  test('url-encodes the user id', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        versions: [{ id: 'v2', status: 'proposed', attributes: {} }],
        liveVersionId: null,
      })
      .mockResolvedValueOnce({
        version: { id: 'v2', status: 'proposed', attributes: {} },
        spine: {},
      });

    await fetchProposedProfileDraft(
      { ...session, user: { id: 'a/b c', email: null } },
      get,
    );

    expect(get).toHaveBeenNthCalledWith(
      1,
      '/profile/versions?user=a%2Fb%20c',
      'access-1',
    );
  });
});
