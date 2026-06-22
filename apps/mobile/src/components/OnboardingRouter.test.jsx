import '@testing-library/jest-dom';
import { getQueriesForElement, render } from '@lynx-js/react/testing-library';
import { beforeEach, expect, test, vi } from 'vitest';

// The router pulls in HomeScreen/IntroScreen → auth → supabase, which read the
// client env at import; stub it. The progress fetch is mocked to drive the step.
vi.mock('../lib/supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../lib/onboarding.js', () => ({ fetchOnboardingProgress: fetchMock }));

import { OnboardingRouter } from './OnboardingRouter.js';

const session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

const onLogout = vi.fn();

function renderAt(step) {
  fetchMock.mockResolvedValue({ user: 'user-1', step });
  render(<OnboardingRouter session={session} onLogout={onLogout} />);
  return getQueriesForElement(elementTree.root);
}

beforeEach(() => {
  fetchMock.mockReset();
  onLogout.mockReset();
});

test('a brand-new user (step=intro) lands on the intro with both paths', async () => {
  const { findByText } = renderAt('intro');

  expect(await findByText("Hi, I'm Archer")).toBeInTheDocument();
  expect(await findByText('Upload my résumé')).toBeInTheDocument();
  expect(await findByText('Start from scratch')).toBeInTheDocument();
});

test('a returning user resumes at their step (step=review)', async () => {
  const { findByText } = renderAt('review');

  expect(await findByText('Your draft is ready')).toBeInTheDocument();
});

test('a completed user (step=done) lands on home', async () => {
  const { findByText } = renderAt('done');

  expect(await findByText("You're signed in")).toBeInTheDocument();
});
