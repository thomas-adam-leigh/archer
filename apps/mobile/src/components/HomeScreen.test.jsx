import '@testing-library/jest-dom';
import {
  fireEvent,
  getQueriesForElement,
  render,
  waitFor,
} from '@lynx-js/react/testing-library';
import { beforeEach, expect, test, vi } from 'vitest';

// HomeScreen pulls in accounts/auth → api.js/supabase.js, which read the client env
// at import; stub them. The account read is injected and sign-out is mocked.
vi.mock('../lib/supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));
vi.mock('../lib/config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));
vi.mock('../lib/auth.js', () => ({ signOut: signOutMock }));

import { HomeScreen } from './HomeScreen.js';

const session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

const onLogout = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  signOutMock.mockResolvedValue(undefined);
});

function renderHome(fetchAccountState) {
  render(
    <HomeScreen
      session={session}
      onLogout={onLogout}
      fetchAccountState={fetchAccountState}
    />,
  );
  return getQueriesForElement(elementTree.root);
}

test('a submitted account shows the "in review" empty-state', async () => {
  const { findByText } = renderHome(vi.fn().mockResolvedValue('submitted'));

  expect(
    await findByText('Archer is reviewing your profile'),
  ).toBeInTheDocument();
});

test('an under_review account also shows the "in review" empty-state', async () => {
  const { findByText } = renderHome(vi.fn().mockResolvedValue('under_review'));

  expect(
    await findByText('Archer is reviewing your profile'),
  ).toBeInTheDocument();
});

test('an accepted account shows the "searching" empty-state', async () => {
  const { findByText } = renderHome(vi.fn().mockResolvedValue('accepted'));

  expect(
    await findByText('Archer is searching for opportunities…'),
  ).toBeInTheDocument();
});

test('a failed account read shows an error with a retry that refetches', async () => {
  const fetchAccountState = vi
    .fn()
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce('accepted');
  const { findByText } = renderHome(fetchAccountState);

  fireEvent.tap(await findByText('Try again'));

  expect(
    await findByText('Archer is searching for opportunities…'),
  ).toBeInTheDocument();
  expect(fetchAccountState).toHaveBeenCalledTimes(2);
});

test('Log out revokes the token and clears local state', async () => {
  const { findByText } = renderHome(vi.fn().mockResolvedValue('submitted'));

  fireEvent.tap(await findByText('Log out'));

  await waitFor(() => expect(signOutMock).toHaveBeenCalledWith('access-1'));
  await waitFor(() => expect(onLogout).toHaveBeenCalled());
});
