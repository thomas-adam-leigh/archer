import { describe, expect, test, vi } from 'vitest';

// Stub the API config so importing the module under test (→ api.js → config.js)
// doesn't require the client env. The fetch is injected below regardless.
vi.mock('./config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import type { Session } from './auth.js';
import {
  fetchOnboardingProgress,
  type OnboardingProgress,
} from './onboarding.js';

const session: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

const progress: OnboardingProgress & { user: string } = {
  user: 'user-1',
  hasProfileData: true,
  draftGenerated: true,
  draftApproved: false,
  titlesGenerated: false,
  titlesApproved: false,
  negativeCriteriaCaptured: false,
  completed: false,
  step: 'review',
  openProposalId: 'prop-1',
  proposedVersionId: 'v2',
};

describe('fetchOnboardingProgress', () => {
  test('requests the user-scoped progress path with the access token', async () => {
    const get = vi.fn().mockResolvedValue(progress);

    const result = await fetchOnboardingProgress(session, get);

    expect(get).toHaveBeenCalledWith(
      '/onboarding/progress?user=user-1',
      'access-1',
    );
    expect(result.step).toBe('review');
  });

  test('url-encodes the user id', async () => {
    const get = vi.fn().mockResolvedValue(progress);

    await fetchOnboardingProgress(
      { ...session, user: { id: 'a/b c', email: null } },
      get,
    );

    expect(get).toHaveBeenCalledWith(
      '/onboarding/progress?user=a%2Fb%20c',
      'access-1',
    );
  });
});
