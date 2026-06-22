import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  getQueriesForElement,
  render,
  waitFor,
} from '@lynx-js/react/testing-library';
import { beforeEach, expect, test, vi } from 'vitest';

// The screen pulls in the AG-UI client → api.js/supabase.js, which read the
// client env at import; stub them (the thread session itself is injected).
vi.mock('../lib/supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));
vi.mock('../lib/config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import { ProcessingScreen } from './ProcessingScreen.js';

const session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};
const ingest = { threadId: 'thread-1', runId: 'run-1' };

function view(state, phase) {
  return { state, messages: [], interrupts: [], phase };
}

/** A fake ThreadSession factory: `loadHistory` seeds `initial`, and `emit`
 *  pushes a fresh view through the captured `onChange` (as Realtime would). */
function makeSession(initial) {
  let onChange = () => {};
  const ts = {
    view: () => initial,
    loadHistory: vi.fn(() => Promise.resolve(initial)),
    subscribe: vi.fn(),
    run: vi.fn(),
    resume: vi.fn(),
    apply: vi.fn(),
    close: vi.fn(),
  };
  const factory = (opts) => {
    onChange = opts.onChange ?? (() => {});
    return ts;
  };
  return { factory, ts, emit: (v) => act(() => onChange(v)) };
}

const onComplete = vi.fn();
const onRetry = vi.fn();

beforeEach(() => {
  onComplete.mockReset();
  onRetry.mockReset();
});

function renderScreen(factory) {
  render(
    <ProcessingScreen
      session={session}
      ingest={ingest}
      onComplete={onComplete}
      onRetry={onRetry}
      createSession={factory}
    />,
  );
  return getQueriesForElement(elementTree.root);
}

test('renders the live phase from real events and advances with the stream', async () => {
  const { factory, emit, ts } = makeSession(
    view({ phase: 'reading' }, 'running'),
  );
  const { findByText } = renderScreen(factory);

  expect(ts.subscribe).toHaveBeenCalled();
  expect(ts.loadHistory).toHaveBeenCalled();
  expect(await findByText('Archer is reading your résumé')).toBeInTheDocument();

  await emit(view({ phase: 'extracting' }, 'running'));
  expect(
    await findByText('Archer is extracting your experience'),
  ).toBeInTheDocument();

  await emit(view({ phase: 'building' }, 'running'));
  expect(
    await findByText('Archer is building your profile'),
  ).toBeInTheDocument();

  expect(onComplete).not.toHaveBeenCalled();
});

test('advances exactly once when the proposed version lands', async () => {
  const done = view(
    { phase: 'complete', versionId: 'ver-9', proposalId: 'prop-9' },
    'completed',
  );
  const { factory, emit } = makeSession(done);
  renderScreen(factory);

  await waitFor(() =>
    expect(onComplete).toHaveBeenCalledWith({
      versionId: 'ver-9',
      proposalId: 'prop-9',
    }),
  );

  // A redelivery of the same terminal event must not re-fire the handoff.
  await emit(done);
  expect(onComplete).toHaveBeenCalledTimes(1);
});

test('a failed run shows a retry that calls onRetry', async () => {
  const { factory } = makeSession(view({ phase: 'building' }, 'error'));
  const { findByText } = renderScreen(factory);

  const retry = await findByText('Try again');
  expect(retry).toBeInTheDocument();
  expect(onComplete).not.toHaveBeenCalled();

  fireEvent.tap(retry);
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('is non-interruptible while running (no cancel/back/sign-out)', async () => {
  const { factory } = makeSession(view({ phase: 'reading' }, 'running'));
  const { findByText, queryByText } = renderScreen(factory);

  await findByText('Archer is reading your résumé');
  expect(queryByText('Sign out')).toBeNull();
  expect(queryByText('Back')).toBeNull();
  expect(queryByText('Cancel')).toBeNull();
  expect(queryByText('Try again')).toBeNull();
});
