# @archer/llm

One swappable LLM provider abstraction for every Archer call-site — the AG-UI
conversational agent (ARC-60) and the mockable seams, Matchmaker triage + Scribe
(ARC-61). Backends (MiniMax direct, OpenRouter, mock) all implement the same
`LlmProvider` interface, so changing provider or model is **config-only**.

## Interface

```ts
import { resolveLlm } from "@archer/llm";

const llm = resolveLlm(); // reads process.env (see below)

// One-shot
const { text } = await llm.complete([{ role: "user", content: "Hello" }]);

// Streamed
for await (const { delta } of llm.stream([{ role: "user", content: "Hello" }])) {
  process.stdout.write(delta);
}
```

`complete(messages, opts?)` → `{ text, model, provider, finishReason?, usage? }`.
`stream(messages, opts?)` yields `{ delta }` text chunks. `opts` = `{ model?, temperature?, maxTokens?, signal? }`.

## Configuration (the swap switch)

`resolveLlm(env = process.env)` picks the backend from environment variables.
**Default = MiniMax M3 via the MiniMax API.** Keys live in Supabase secrets and
are read from the env — never hardcoded.

| Variable | Purpose | Default |
| --- | --- | --- |
| `LLM_PROVIDER` | `minimax` \| `openrouter` \| `mock` | `minimax` |
| `LLM_MODEL` | Overrides the chosen provider's default model | — |
| `MINIMAX_API_KEY` | Secret for the MiniMax backend (required when provider=minimax) | — |
| `MINIMAX_BASE_URL` | MiniMax endpoint override | `https://api.minimax.io/v1` |
| `MINIMAX_MODEL` | MiniMax model (if `LLM_MODEL` unset) | `MiniMax-M3` |
| `OPENROUTER_API_KEY` | Secret for OpenRouter (required when provider=openrouter) | — |
| `OPENROUTER_BASE_URL` | OpenRouter endpoint override | `https://openrouter.ai/api/v1` |
| `OPENROUTER_MODEL` | OpenRouter model (if `LLM_MODEL` unset) | `minimax/minimax-m3` |
| `OPENROUTER_REFERER` / `OPENROUTER_TITLE` | Optional openrouter.ai attribution | — |

`resolveLlm` **fails closed**: it throws `LlmConfigError` if the selected
provider's key is missing. MiniMax M3 is reachable both directly
(`LLM_PROVIDER=minimax`) and via OpenRouter BYOK (`LLM_PROVIDER=openrouter`,
`LLM_MODEL=minimax/minimax-m3`) with no code change.

## Testing

Use the mock backend (`LLM_PROVIDER=mock` or `createMockProvider()`) — it's
deterministic and never touches the network, so CI never needs a live model.
For HTTP-level tests, inject a `fetch` double via `createMinimaxProvider({ fetch })`.

`src/smoke.test.ts` hits the real provider, but only when a key is present in the
env (skipped otherwise).
