import { careerjunction } from "./careerjunction.js";
import type { BoardAdapter } from "./types.js";

// Board slug -> adapter. Boards without an entry have no collect adapter yet
// (collect_status stays not_integrated until a sprint maps their selectors).
const ADAPTERS: Record<string, BoardAdapter> = {
  [careerjunction.slug]: careerjunction,
};

export function getAdapter(slug: string): BoardAdapter | undefined {
  return ADAPTERS[slug];
}

export * from "./types.js";
