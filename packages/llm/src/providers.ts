import { LlmConfigError } from "./errors.js";
import { createMockProvider } from "./mock.js";
import { createOpenAiCompatibleProvider, type FetchLike } from "./openai-compatible.js";
import type { LlmProvider } from "./types.js";

export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_DEFAULT_MODEL = "MiniMax-M3";
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
/** MiniMax M3 served via OpenRouter (the user's BYOK MiniMax plan). */
export const OPENROUTER_DEFAULT_MODEL = "minimax/minimax-m3";

export interface MinimaxOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

/** MiniMax direct, via its OpenAI-compatible `/chat/completions` endpoint. */
export function createMinimaxProvider(opts: MinimaxOptions): LlmProvider {
  return createOpenAiCompatibleProvider({
    name: "minimax",
    baseUrl: opts.baseUrl ?? MINIMAX_DEFAULT_BASE_URL,
    apiKey: opts.apiKey,
    defaultModel: opts.model ?? MINIMAX_DEFAULT_MODEL,
    fetch: opts.fetch,
  });
}

export interface OpenRouterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Optional attribution surfaced on openrouter.ai. */
  referer?: string;
  title?: string;
  fetch?: FetchLike;
}

/** OpenRouter — any model via one key (BYOK supported). */
export function createOpenRouterProvider(opts: OpenRouterOptions): LlmProvider {
  const headers: Record<string, string> = {};
  if (opts.referer) headers["http-referer"] = opts.referer;
  if (opts.title) headers["x-openrouter-title"] = opts.title;
  return createOpenAiCompatibleProvider({
    name: "openrouter",
    baseUrl: opts.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
    apiKey: opts.apiKey,
    defaultModel: opts.model ?? OPENROUTER_DEFAULT_MODEL,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    fetch: opts.fetch,
  });
}

/** Subset of `process.env` the resolver reads. */
export type LlmEnv = Record<string, string | undefined>;

export interface ResolveOptions {
  fetch?: FetchLike;
}

/**
 * Pick a provider from the environment — the single config switch behind
 * "swappable with no code changes". Defaults to MiniMax M3.
 *
 * - `LLM_PROVIDER` — `minimax` (default) | `openrouter` | `mock`
 * - `LLM_MODEL` — overrides the chosen provider's default model
 * - `MINIMAX_API_KEY` / `OPENROUTER_API_KEY` — the secret for the chosen provider
 * - `MINIMAX_BASE_URL` / `OPENROUTER_BASE_URL` — optional endpoint overrides
 * - `OPENROUTER_REFERER` / `OPENROUTER_TITLE` — optional attribution
 *
 * Fail-closed: throws {@link LlmConfigError} if the selected provider's key is absent.
 */
export function resolveLlm(env: LlmEnv = process.env, opts: ResolveOptions = {}): LlmProvider {
  const provider = (env.LLM_PROVIDER ?? "minimax").toLowerCase();
  const model = env.LLM_MODEL;

  switch (provider) {
    case "mock":
      return createMockProvider({ model });

    case "minimax": {
      const apiKey = env.MINIMAX_API_KEY;
      if (!apiKey) {
        throw new LlmConfigError("MINIMAX_API_KEY is required when LLM_PROVIDER=minimax");
      }
      return createMinimaxProvider({
        apiKey,
        model: model ?? env.MINIMAX_MODEL,
        baseUrl: env.MINIMAX_BASE_URL,
        fetch: opts.fetch,
      });
    }

    case "openrouter": {
      const apiKey = env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new LlmConfigError("OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter");
      }
      return createOpenRouterProvider({
        apiKey,
        model: model ?? env.OPENROUTER_MODEL,
        baseUrl: env.OPENROUTER_BASE_URL,
        referer: env.OPENROUTER_REFERER,
        title: env.OPENROUTER_TITLE,
        fetch: opts.fetch,
      });
    }

    default:
      throw new LlmConfigError(
        `Unknown LLM_PROVIDER "${provider}" (expected minimax | openrouter | mock)`,
      );
  }
}
