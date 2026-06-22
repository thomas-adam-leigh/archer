import '@testing-library/jest-dom';
import {
  fireEvent,
  getQueriesForElement,
  render,
} from '@lynx-js/react/testing-library';
import { beforeEach, expect, test, vi } from 'vitest';

// The router pulls in HomeScreen/IntroScreen → auth → supabase, which read the
// client env at import; stub it. The progress fetch is mocked to drive the step.
vi.mock('../lib/supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));
// The résumé screen pulls in resume.js → api.js → config.js, which reads the
// client env at import; stub it (no network is made in these render tests).
vi.mock('../lib/config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

const { fetchMock, draftMock, accountStateMock, completeMock } = vi.hoisted(
  () => ({
    fetchMock: vi.fn(),
    draftMock: vi.fn(),
    accountStateMock: vi.fn(),
    completeMock: vi.fn(),
  }),
);
vi.mock('../lib/onboarding.js', () => ({ fetchOnboardingProgress: fetchMock }));
// The review step renders the profile-review screen, which self-resolves the
// proposed draft; mock that fetch so the router test drives routing, not network.
vi.mock('../lib/profile.js', async (importActual) => ({
  ...(await importActual()),
  fetchProposedProfileDraft: draftMock,
}));
// The done step renders home (reads account state) and the submitting step submits
// the account; mock both so the router test drives routing, not network.
vi.mock('../lib/accounts.js', () => ({
  fetchAccountState: accountStateMock,
  completeOnboarding: completeMock,
}));

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
  draftMock.mockReset();
  accountStateMock.mockReset();
  completeMock.mockReset();
  onLogout.mockReset();
});

test('a brand-new user (step=intro) lands on the intro with both paths', async () => {
  const { findByText } = renderAt('intro');

  expect(await findByText("Hi, I'm Archer")).toBeInTheDocument();
  expect(await findByText('Upload my résumé')).toBeInTheDocument();
  expect(await findByText('Start from scratch')).toBeInTheDocument();
});

test('choosing "Start from scratch" opens the guided chat', async () => {
  const { findByText } = renderAt('intro');

  fireEvent.tap(await findByText('Start from scratch'));
  // The chat resolves the thread first; its loading copy is enough to prove the
  // scratch path now routes to the conversational screen, not a stand-in.
  expect(await findByText('Getting Archer ready…')).toBeInTheDocument();
});

test('a returning user resumes at their step (step=review)', async () => {
  draftMock.mockResolvedValue({
    version: {
      id: 'v9',
      status: 'proposed',
      attributes: { full_name: 'Resumed Draft' },
    },
    spine: {},
  });
  const { findByText } = renderAt('review');

  expect(await findByText('Resumed Draft')).toBeInTheDocument();
});

test('a completed user (step=done) lands on the status-aware home', async () => {
  accountStateMock.mockResolvedValue('accepted');
  const { findByText } = renderAt('done');

  expect(
    await findByText('Archer is searching for opportunities…'),
  ).toBeInTheDocument();
});

test('the submitting step submits the account, then lands on home', async () => {
  // First read is `submitting`; once completion lands, the re-read returns `done`.
  fetchMock
    .mockResolvedValueOnce({ user: 'user-1', step: 'submitting' })
    .mockResolvedValueOnce({ user: 'user-1', step: 'done' });
  completeMock.mockResolvedValue('submitted');
  accountStateMock.mockResolvedValue('submitted');

  render(<OnboardingRouter session={session} onLogout={onLogout} />);
  const { findByText } = getQueriesForElement(elementTree.root);

  expect(
    await findByText('Archer is reviewing your profile'),
  ).toBeInTheDocument();
  expect(completeMock).toHaveBeenCalledTimes(1);
});
