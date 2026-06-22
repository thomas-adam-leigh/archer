import { root } from '@lynx-js/react'

import { App } from './App.js'

// NOTE: the ReactLynx debug build (@lynx-js/react/debug) and Preact devtools were
// imported here unconditionally, which shipped them into the PRODUCTION bundle. On a
// real device (no devtools bridge) that hooks the render/event pipeline and leaves the
// UI rendered but unresponsive to touch. They are dev-only aids, so they're removed.

root.render(<App />)

if (import.meta.webpackHot) {
  import.meta.webpackHot.accept()
}
