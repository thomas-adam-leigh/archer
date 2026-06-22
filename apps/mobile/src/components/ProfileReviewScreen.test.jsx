import '@testing-library/jest-dom';
import {
  fireEvent,
  getQueriesForElement,
  render,
  waitFor,
} from '@lynx-js/react/testing-library';
import { beforeEach, expect, test, vi } from 'vitest';

// The screen pulls in the profile/voice/threads libs → api.js/supabase.js, which
// read the client env at import; stub them (every network + voice seam is injected).
vi.mock('../lib/config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));
vi.mock('../lib/supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));

import { NoProposedVersionError } from '../lib/profile.js';
import { ProfileReviewScreen } from './ProfileReviewScreen.js';

const session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

const fullDraft = {
  version: {
    id: 'v2',
    status: 'proposed',
    attributes: {
      full_name: 'Ada Lovelace',
      email: 'ada@analytical.io',
      location: 'London, UK',
      summary: 'Pioneering programmer.',
      links: { github: 'github.com/ada' },
    },
  },
  spine: {
    workExperiences: [
      {
        title: 'Lead Engineer',
        organization: 'Analytical Engine Co.',
        startDate: '2020-01-01',
        isCurrent: true,
        description: 'Built the first algorithm.',
      },
    ],
    education: [{ institution: 'University of London', degree: 'Mathematics' }],
    skills: [{ name: 'Algorithms' }, { name: 'Mathematics' }],
    certifications: [{ name: 'Fellow', issuer: 'Royal Society' }],
    courses: [{ name: 'Analysis', provider: 'Self-taught' }],
    projects: [{ name: 'Note G', description: 'Bernoulli numbers.' }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

/** Render with an injected draft fetch + defaulted, overridable action seams. */
function renderScreen(fetchDraft, over = {}) {
  const seams = {
    proposalId: 'prop-1',
    onApproved: vi.fn(),
    onRevised: vi.fn(),
    approve: vi.fn(() => Promise.resolve()),
    revise: vi.fn(() => Promise.resolve({ threadId: 't1', runId: 'r1' })),
    resolveThreadId: vi.fn(() => Promise.resolve('t1')),
    captureVoice: vi.fn(() => Promise.resolve('')),
    ...over,
  };
  render(
    <ProfileReviewScreen
      session={session}
      fetchDraft={fetchDraft}
      proposalId={seams.proposalId}
      onApproved={seams.onApproved}
      onRevised={seams.onRevised}
      approve={seams.approve}
      revise={seams.revise}
      resolveThreadId={seams.resolveThreadId}
      captureVoice={seams.captureVoice}
    />,
  );
  return { ...getQueriesForElement(elementTree.root), seams };
}

test('renders the proposed draft résumé-style across all sections', async () => {
  const { findByText, getByText } = renderScreen(() =>
    Promise.resolve(fullDraft),
  );

  expect(await findByText('Ada Lovelace')).toBeInTheDocument();
  getByText('London, UK');
  getByText('ada@analytical.io');
  getByText('github.com/ada');
  getByText('Pioneering programmer.');

  // Section headers + their items.
  getByText('Experience');
  getByText('Lead Engineer');
  getByText('Analytical Engine Co. · Jan 2020 – Present');
  getByText('Built the first algorithm.');
  getByText('Education');
  getByText('University of London');
  getByText('Skills');
  getByText('Algorithms');
  getByText('Certifications');
  getByText('Fellow');
  getByText('Courses');
  getByText('Analysis');
  getByText('Projects');
  getByText('Note G');
});

test('omits empty sections gracefully (only what the draft has)', async () => {
  const sparse = {
    version: {
      id: 'v3',
      status: 'proposed',
      attributes: { full_name: 'Grace' },
    },
    spine: {},
  };
  const { findByText, queryByText } = renderScreen(() =>
    Promise.resolve(sparse),
  );

  expect(await findByText('Grace')).toBeInTheDocument();
  expect(queryByText('Experience')).toBeNull();
  expect(queryByText('Education')).toBeNull();
  expect(queryByText('Skills')).toBeNull();
  expect(queryByText('Summary')).toBeNull();
});

test('shows a graceful empty state when nothing is awaiting review', async () => {
  const { findByText } = renderScreen(() =>
    Promise.reject(new NoProposedVersionError()),
  );
  expect(await findByText('Nothing to review yet')).toBeInTheDocument();
});

test('shows an error with a retry that reloads', async () => {
  const fetchDraft = vi.fn(() => Promise.reject(new Error('boom')));
  const { findByText } = renderScreen(fetchDraft);

  const retry = await findByText('Try again');
  expect(fetchDraft).toHaveBeenCalledTimes(1);

  fireEvent.tap(retry);
  await waitFor(() => expect(fetchDraft).toHaveBeenCalledTimes(2));
});

test('approve self-approves the open proposal and advances', async () => {
  const { findByText, getByText, seams } = renderScreen(() =>
    Promise.resolve(fullDraft),
  );

  await findByText('Ada Lovelace');
  fireEvent.tap(getByText('Approve & continue'));

  await waitFor(() =>
    expect(seams.approve).toHaveBeenCalledWith(session, 'prop-1'),
  );
  await waitFor(() => expect(seams.onApproved).toHaveBeenCalledTimes(1));
});

test('approve is a no-op until the proposal id resolves', async () => {
  const { findByText, getByText, seams } = renderScreen(
    () => Promise.resolve(fullDraft),
    { proposalId: null },
  );

  await findByText('Ada Lovelace');
  fireEvent.tap(getByText('Approve & continue'));
  expect(seams.approve).not.toHaveBeenCalled();
  expect(seams.onApproved).not.toHaveBeenCalled();
});

test('Send to Archer is a no-op with no feedback entered', async () => {
  const { findByText, getByText, seams } = renderScreen(() =>
    Promise.resolve(fullDraft),
  );

  await findByText('Ada Lovelace');
  fireEvent.tap(getByText('Send to Archer'));
  expect(seams.revise).not.toHaveBeenCalled();
  expect(seams.onRevised).not.toHaveBeenCalled();
});

test('voice feedback transcribes then starts a revise run and hands it up', async () => {
  const captureVoice = vi.fn(() => Promise.resolve('drop the summary'));
  const { findByText, getByText, seams } = renderScreen(
    () => Promise.resolve(fullDraft),
    { captureVoice },
  );

  await findByText('Ada Lovelace');
  fireEvent.tap(getByText('🎤 Feedback by voice'));

  await waitFor(() =>
    expect(seams.revise).toHaveBeenCalledWith(session, {
      threadId: 't1',
      feedback: 'drop the summary',
    }),
  );
  await waitFor(() =>
    expect(seams.onRevised).toHaveBeenCalledWith({
      threadId: 't1',
      runId: 'r1',
    }),
  );
});

test('surfaces a voice-capture failure without crashing', async () => {
  const captureVoice = vi.fn(() => Promise.reject(new Error('mic off')));
  const { findByText } = renderScreen(() => Promise.resolve(fullDraft), {
    captureVoice,
  });

  await findByText('Ada Lovelace');
  fireEvent.tap(await findByText('🎤 Feedback by voice'));

  expect(
    await findByText("Couldn't capture your voice. Please try again."),
  ).toBeInTheDocument();
});
