import type { AppType } from "@archer/api";
import { hc } from "hono/client";

export const apiBaseUrl = process.env.ARCHER_API_URL ?? "http://localhost:3000";

/** A fetch the typed client uses for transport. Defaults to the global `fetch`;
 *  tests pass `app.request` to mount the Hono app in-process (no network). */
export type ClientFetch = (
  input: RequestInfo | URL,
  requestInit?: RequestInit,
) => Response | Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: ClientFetch;
}

/** Build the typed `hc<AppType>` RPC client the CLI talks to. The end-to-end
 *  proof (proof.test.ts) reuses this exact construction, mounting the app over an
 *  in-process `fetch`, so the flow it exercises is the one real clients consume. */
export function createApiClient(opts: ApiClientOptions = {}) {
  const { baseUrl = apiBaseUrl, fetch } = opts;
  return hc<AppType>(baseUrl, fetch ? { fetch } : undefined);
}

/** The default client, pointed at $ARCHER_API_URL (or localhost). */
export const api = createApiClient();
