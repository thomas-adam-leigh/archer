import { describe, expect, test, vi } from 'vitest';

// Stub the API config so importing the module under test (→ api.js → config.js)
// doesn't require the client env. The post is injected below regardless.
vi.mock('./config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import type { Session } from './auth.js';
import { finalizeGuidedOnboarding } from './conversation.js';

const session: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

describe('finalizeGuidedOnboarding', () => {
  test('posts the threadId and returns the proposed version', async () => {
    const post = vi.fn().mockResolvedValue({
      threadId: 't1',
      runId: 'r1',
      status: 'proposed',
      versionId: 'v9',
      proposalId: 'p9',
    });

    const result = await finalizeGuidedOnboarding(session, 't1', post);

    expect(post).toHaveBeenCalledWith('/onboarding/guided', 'access-1', {
      threadId: 't1',
    });
    expect(result).toEqual({ versionId: 'v9', proposalId: 'p9' });
  });

  test('propagates a failure so the screen can show an error', async () => {
    const post = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(finalizeGuidedOnboarding(session, 't1', post)).rejects.toThrow(
      'boom',
    );
  });
});
