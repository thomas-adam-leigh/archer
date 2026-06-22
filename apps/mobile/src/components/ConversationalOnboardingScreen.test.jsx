import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  getQueriesForElement,
  render,
  waitFor,
} from '@lynx-js/react/testing-library';
import { beforeEach, expect, test, vi } from 'vitest';

// The screen pulls in the AG-UI client + conversation/voice libs → api.js/
// supabase.js, which read the client env at import; stub them (every network +
// voice seam, and the thread session itself, is injected below).
vi.mock('../lib/supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));
vi.mock('../lib/config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import { ConversationalOnboardingScreen } from './ConversationalOnboardingScreen.js';

const session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

function view(messages, phase = 'completed') {
  return { state: {}, messages, interrupts: [], phase };
}

/** A fake ThreadSession: `loadHistory` seeds `initial`, `view()` returns the live
 *  folded view, and `emit` pushes a fresh view through the captured `onChange`. */
function makeSession(initial) {
  let onChange = () => {};
  let current = initial;
  const ts = {
    view: () => current,
    loadHistory: vi.fn(() => Promise.resolve(initial)),
    subscribe: vi.fn(),
    run: vi.fn(() => Promise.resolve({ threadId: 'thread-1', events: [] })),
    resume: vi.fn(),
    apply: vi.fn(),
    close: vi.fn(),
  };
  const factory = (opts) => {
    onChange = opts.onChange ?? (() => {});
    return ts;
  };
  return {
    factory,
    ts,
    emit: (v) =>
      act(() => {
        current = v;
        onChange(v);
      }),
  };
}

const onComplete = vi.fn();

beforeEach(() => {
  onComplete.mockReset();
});

function renderScreen(over = {}) {
  render(
    <ConversationalOnboardingScreen
      session={session}
      onComplete={over.onComplete ?? onComplete}
      onBack={over.onBack}
      resolveThreadId={
        over.resolveThreadId ?? (() => Promise.resolve('thread-1'))
      }
      deps={over.deps}
    />,
  );
  return getQueriesForElement(elementTree.root);
}

test('Archer opens the chat with a greeting run, then renders its question', async () => {
  const { factory, ts, emit } = makeSession(view([]));
  const { findByText } = renderScreen({ deps: { createSession: factory } });

  // The opener kicks a run with no user turn so the brain asks the first question.
  await waitFor(() => expect(ts.run).toHaveBeenCalledWith({ messages: [] }));
  expect(ts.subscribe).toHaveBeenCalled();
  expect(ts.loadHistory).toHaveBeenCalled();

  await emit(
    view([
      { id: 'a1', role: 'assistant', content: 'Tell me about your work.' },
    ]),
  );
  expect(await findByText('Tell me about your work.')).toBeInTheDocument();
});

test('answering by voice sends the transcript with the full transcript as context', async () => {
  const { factory, ts, emit } = makeSession(view([]));
  const captureVoice = vi.fn(() => Promise.resolve('I build TypeScript APIs.'));
  const { findByText, getByText } = renderScreen({
    deps: { createSession: factory, captureVoice },
  });

  await waitFor(() => expect(ts.run).toHaveBeenCalledWith({ messages: [] }));
  await emit(
    view([{ id: 'a1', role: 'assistant', content: 'What do you do?' }]),
  );
  await findByText('What do you do?');

  fireEvent.tap(getByText('🎤 Answer by voice'));

  // The new user turn is appended to the assistant's question (the brain reads the
  // history for context).
  await waitFor(() =>
    expect(ts.run).toHaveBeenLastCalledWith({
      messages: [
        { role: 'assistant', content: 'What do you do?' },
        { role: 'user', content: 'I build TypeScript APIs.' },
      ],
    }),
  );
  // The run folds both turns back into the view (as the response / Realtime does);
  // the user's message then renders in the transcript.
  await emit(
    view([
      { id: 'a1', role: 'assistant', content: 'What do you do?' },
      { id: 'u1', role: 'user', content: 'I build TypeScript APIs.' },
    ]),
  );
  expect(await findByText('I build TypeScript APIs.')).toBeInTheDocument();
});

test('surfaces a voice-capture failure without crashing', async () => {
  const { factory, ts } = makeSession(view([]));
  const captureVoice = vi.fn(() => Promise.reject(new Error('mic off')));
  const { findByText, getByText } = renderScreen({
    deps: { createSession: factory, captureVoice },
  });

  await waitFor(() => expect(ts.run).toHaveBeenCalled());
  fireEvent.tap(getByText('🎤 Answer by voice'));

  expect(
    await findByText("Couldn't capture your voice. Please try again."),
  ).toBeInTheDocument();
});

test('"build my profile" finalizes the conversation and advances to review', async () => {
  const { factory, ts, emit } = makeSession(view([]));
  const finalize = vi.fn(() =>
    Promise.resolve({ versionId: 'v9', proposalId: 'p9' }),
  );
  const { findByText, getByText } = renderScreen({
    deps: { createSession: factory, finalize },
  });

  await waitFor(() => expect(ts.run).toHaveBeenCalled());
  await emit(
    view([
      { id: 'a1', role: 'assistant', content: 'Tell me about your work.' },
      { id: 'u1', role: 'user', content: 'I build APIs.' },
    ]),
  );
  await findByText('I build APIs.');

  fireEvent.tap(getByText("I'm done — build my profile"));

  await waitFor(() =>
    expect(finalize).toHaveBeenCalledWith(session, 'thread-1'),
  );
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
});

test('"build my profile" is a no-op before the candidate has said anything', async () => {
  const { factory, ts } = makeSession(view([]));
  const finalize = vi.fn();
  const { getByText } = renderScreen({
    deps: { createSession: factory, finalize },
  });

  await waitFor(() => expect(ts.run).toHaveBeenCalled());
  fireEvent.tap(getByText("I'm done — build my profile"));
  expect(finalize).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
});

test('a thread-resolution failure shows a retry path', async () => {
  const { factory } = makeSession(view([]));
  const { findByText } = renderScreen({
    resolveThreadId: () => Promise.reject(new Error('no thread')),
    deps: { createSession: factory },
  });

  expect(await findByText("Couldn't start the chat")).toBeInTheDocument();
  expect(await findByText('Try again')).toBeInTheDocument();
});
