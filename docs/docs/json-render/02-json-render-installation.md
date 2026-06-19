---
url: https://json-render.dev/docs/installation
---

# Installation

Install the core package plus your renderer of choice.

## For React UI

```bash
npm install @json-render/core @json-render/react
```

Peer dependencies: `react ^19.0.0` and `zod ^4.0.0`.

```bash
npm install react zod
```

## For Vue

```bash
npm install @json-render/core @json-render/vue
```

Peer dependencies: `vue ^3.5.0` and `zod ^4.0.0`.

```bash
npm install vue zod
```

## For Svelte

```bash
npm install @json-render/core @json-render/svelte
```

Peer dependencies: `svelte ^5.0.0` and `zod ^4.0.0`.

```bash
npm install svelte zod
```

## For React UI with shadcn/ui

Pre-built components for fast prototyping and production use:

```bash
npm install @json-render/core @json-render/react @json-render/shadcn
```

Requires Tailwind CSS in your project. See the [@json-render/shadcn API reference](/docs/api/shadcn) for usage.

## For React Native

```bash
npm install @json-render/core @json-render/react-native
```

## For Remotion Video

```bash
npm install @json-render/core @json-render/remotion remotion @remotion/player
```

## For React Email

```bash
npm install @json-render/core @json-render/react-email @react-email/components @react-email/render
```

## For External State Management (Optional)

If you want to wire json-render to an existing state management library instead of the built-in store, install the adapter for your library:

```bash
npm install @json-render/zustand
```

```bash
npm install @json-render/redux
```

```bash
npm install @json-render/jotai
```

```bash
npm install @json-render/xstate
```

See the [Data Binding](/docs/data-binding#external-store-controlled-mode) guide for usage.

## For AI Integration

To use json-render with AI models, you'll also need the Vercel AI SDK:

```bash
npm install ai
```
