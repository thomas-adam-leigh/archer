// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
import '@testing-library/jest-dom'
import { expect, test, vi } from 'vitest'
import { getQueriesForElement, render } from '@lynx-js/react/testing-library'

vi.mock('../lib/supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}))

import { App } from '../App'

test('App renders the sign-in screen when signed out', async () => {
  render(<App />)

  const { findByText } = getQueriesForElement(elementTree.root)
  const element = await findByText('Sign in')

  expect(element).toBeInTheDocument()
})
