import { describe, expect, test, vi } from 'vitest';

// Stub the API config so importing the module under test (→ api.js → config.js)
// doesn't require the client env. The post is injected below regardless.
vi.mock('./config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import type { Session } from './auth.js';
import {
  addNegativeCriterion,
  approveTitles,
  suggestTitles,
} from './preferences.js';

const session: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

describe('suggestTitles', () => {
  test('posts the user-scoped suggest request and returns the suggestions', async () => {
    const post = vi.fn().mockResolvedValue({
      user: 'user-1',
      suggestions: ['A', 'B'],
      model: 'm',
    });

    const titles = await suggestTitles(session, {}, post);

    expect(post).toHaveBeenCalledWith(
      '/onboarding/titles/suggest',
      'access-1',
      {
        userId: 'user-1',
        feedback: undefined,
        current: undefined,
      },
    );
    expect(titles).toEqual(['A', 'B']);
  });

  test('passes feedback + the current list through for a re-rank', async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ user: 'user-1', suggestions: ['B', 'A'] });

    await suggestTitles(
      session,
      { feedback: 'put B first', current: ['A', 'B'] },
      post,
    );

    expect(post).toHaveBeenCalledWith(
      '/onboarding/titles/suggest',
      'access-1',
      {
        userId: 'user-1',
        feedback: 'put B first',
        current: ['A', 'B'],
      },
    );
  });

  test('tolerates a response with no suggestions', async () => {
    const post = vi.fn().mockResolvedValue({ user: 'user-1' });
    expect(await suggestTitles(session, {}, post)).toEqual([]);
  });
});

describe('approveTitles', () => {
  test('posts the chosen titles to the approve route', async () => {
    const post = vi.fn().mockResolvedValue({ user: 'user-1', titles: [] });

    await approveTitles(session, ['A', 'B'], post);

    expect(post).toHaveBeenCalledWith(
      '/onboarding/titles/approve',
      'access-1',
      {
        userId: 'user-1',
        titles: ['A', 'B'],
      },
    );
  });
});

describe('addNegativeCriterion', () => {
  test('posts the rule-out and returns the saved criterion', async () => {
    const post = vi.fn().mockResolvedValue({
      user: 'user-1',
      criterion: { id: 'c1', text: 'no crypto' },
    });

    const saved = await addNegativeCriterion(session, 'no crypto', post);

    expect(post).toHaveBeenCalledWith('/criteria', 'access-1', {
      userId: 'user-1',
      text: 'no crypto',
    });
    expect(saved).toEqual({ id: 'c1', text: 'no crypto' });
  });
});
