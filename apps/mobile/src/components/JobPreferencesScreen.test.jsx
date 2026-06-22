import '@testing-library/jest-dom';
import {
  fireEvent,
  getQueriesForElement,
  render,
  waitFor,
} from '@lynx-js/react/testing-library';
import { beforeEach, expect, test, vi } from 'vitest';

// The screen pulls in the preferences/voice libs → api.js/supabase.js, which read
// the client env at import; stub them (every network + voice seam is injected).
vi.mock('../lib/supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));
vi.mock('../lib/config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import { JobPreferencesScreen } from './JobPreferencesScreen.js';

const session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

const onApproved = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  onApproved.mockReset();
});

/** Render with sensible defaults; override any seam per test. */
function renderScreen(over = {}) {
  const seams = {
    suggest: vi.fn(() => Promise.resolve(['Staff Engineer', 'Tech Lead'])),
    approve: vi.fn(() => Promise.resolve()),
    addCriterion: vi.fn((_s, text) => Promise.resolve({ id: 'c1', text })),
    captureVoice: vi.fn(() => Promise.resolve('')),
    ...over,
  };
  render(
    <JobPreferencesScreen
      session={session}
      onApproved={onApproved}
      suggest={seams.suggest}
      approve={seams.approve}
      addCriterion={seams.addCriterion}
      captureVoice={seams.captureVoice}
    />,
  );
  return { ...getQueriesForElement(elementTree.root), seams };
}

test('renders the suggested titles, numbered', async () => {
  const { findByText, getByText } = renderScreen();

  expect(await findByText('1. Staff Engineer')).toBeInTheDocument();
  getByText('2. Tech Lead');
});

test('re-ranks live from voice feedback (sends feedback + the current list)', async () => {
  const suggest = vi
    .fn()
    .mockResolvedValueOnce(['Staff Engineer', 'Tech Lead'])
    .mockResolvedValueOnce(['Tech Lead', 'Staff Engineer']);
  const captureVoice = vi.fn(() => Promise.resolve('put Tech Lead first'));
  const { findByText, getByText } = renderScreen({ suggest, captureVoice });

  await findByText('1. Staff Engineer');
  fireEvent.tap(getByText('🎤 Refine by voice'));

  expect(await findByText('1. Tech Lead')).toBeInTheDocument();
  await waitFor(() =>
    expect(suggest).toHaveBeenLastCalledWith(session, {
      feedback: 'put Tech Lead first',
      current: ['Staff Engineer', 'Tech Lead'],
    }),
  );
});

test('captures a rule-out by voice and shows it as a chip', async () => {
  const captureVoice = vi.fn(() => Promise.resolve('no crypto'));
  const { findByText, getByText, seams } = renderScreen({ captureVoice });

  await findByText('1. Staff Engineer');
  fireEvent.tap(getByText('🎤 Add by voice'));

  expect(await findByText('no crypto')).toBeInTheDocument();
  expect(seams.addCriterion).toHaveBeenCalledWith(session, 'no crypto');
});

test('approval is gated on at least one rule-out', async () => {
  const { findByText, getByText, seams } = renderScreen();

  await findByText('1. Staff Engineer');
  // No criterion yet → approve is a no-op.
  fireEvent.tap(getByText('Approve & continue'));
  expect(seams.approve).not.toHaveBeenCalled();
  expect(onApproved).not.toHaveBeenCalled();
});

test('approves the titles and advances once a rule-out is saved', async () => {
  const captureVoice = vi.fn(() => Promise.resolve('no relocation'));
  const { findByText, getByText, seams } = renderScreen({ captureVoice });

  await findByText('1. Staff Engineer');
  fireEvent.tap(getByText('🎤 Add by voice'));
  await findByText('no relocation');

  fireEvent.tap(getByText('Approve & continue'));
  await waitFor(() =>
    expect(seams.approve).toHaveBeenCalledWith(session, [
      'Staff Engineer',
      'Tech Lead',
    ]),
  );
  await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
});

test('shows an error with a retry when the first suggestion fails', async () => {
  const suggest = vi
    .fn()
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce(['Staff Engineer']);
  const { findByText } = renderScreen({ suggest });

  const retry = await findByText('Try again');
  expect(suggest).toHaveBeenCalledTimes(1);

  fireEvent.tap(retry);
  expect(await findByText('1. Staff Engineer')).toBeInTheDocument();
});

test('surfaces a voice-capture failure without crashing', async () => {
  const captureVoice = vi.fn(() => Promise.reject(new Error('mic off')));
  const { findByText } = renderScreen({ captureVoice });

  await findByText('1. Staff Engineer');
  fireEvent.tap(await findByText('🎤 Add by voice'));

  expect(
    await findByText("Couldn't capture your voice. Please try again."),
  ).toBeInTheDocument();
});
