// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
import '@testing-library/jest-dom';
import { getQueriesForElement, render } from '@lynx-js/react/testing-library';
import { expect, test, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));

vi.mock('../lib/config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));

import { App } from '../App';

test('App renders the sign-in screen when signed out', async () => {
  render(<App />);

  const { findByText } = getQueriesForElement(elementTree.root);
  const element = await findByText('Sign in');

  expect(element).toBeInTheDocument();
});
