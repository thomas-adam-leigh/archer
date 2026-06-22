import '@testing-library/jest-dom';
import {
  fireEvent,
  getQueriesForElement,
  render,
  waitFor,
} from '@lynx-js/react/testing-library';
import { beforeEach, expect, test, vi } from 'vitest';

// CompletionScreen pulls in accounts → api.js → config.js, which reads the client
// env at import; stub it. The completion call is injected.
vi.mock('../lib/config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import { CompletionScreen } from './CompletionScreen.js';

const session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

const onComplete = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

function renderScreen(complete) {
  render(
    <CompletionScreen
      session={session}
      onComplete={onComplete}
      complete={complete}
    />,
  );
  return getQueriesForElement(elementTree.root);
}

test('submits the account on mount, then hands back to the router', async () => {
  const complete = vi.fn().mockResolvedValue('submitted');
  renderScreen(complete);

  await waitFor(() => expect(complete).toHaveBeenCalledWith(session));
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
});

test('a failed submit shows a retry that re-submits', async () => {
  const complete = vi
    .fn()
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce('submitted');
  const { findByText } = renderScreen(complete);

  fireEvent.tap(await findByText('Try again'));

  await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
});
