import '@testing-library/jest-dom';
import {
  fireEvent,
  getQueriesForElement,
  render,
  waitFor,
} from '@lynx-js/react/testing-library';
import { beforeEach, expect, test, vi } from 'vitest';

// The screen pulls in the profile lib → api.js → config.js, which reads the
// client env at import; stub it (the draft fetch itself is injected).
vi.mock('../lib/config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

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

function renderScreen(fetchDraft) {
  render(<ProfileReviewScreen session={session} fetchDraft={fetchDraft} />);
  return getQueriesForElement(elementTree.root);
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
