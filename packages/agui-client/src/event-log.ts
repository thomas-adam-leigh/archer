/**
 * The reconciling event log.
 *
 * A client gets the same events from three places: the `GET /agui/threads/:id/history`
 * restore, the synchronous `POST /agui/run` response, and live Supabase Realtime
 * `events` INSERTs. They overlap — a run's rows arrive both in its run response
 * and (a moment later) over Realtime. The append-only `events` table guarantees a
 * unique `(run_id, seq)` per row, so that pair is the dedupe key: fold the union,
 * ordered, and the live view converges with the restored one regardless of arrival
 * order (`docs/CLIENT-INTEGRATION.md` §4).
 *
 * This module is pure: it normalizes each source to a `KeyedEvent`, dedupes by
 * `(runId, seq)`, and orders by run-first-seen then seq. Folding the result with
 * `foldEvents` yields the `ThreadView`.
 */

import {
  type AguiEvent,
  type EventType,
  foldEvents,
  type Json,
  type ThreadView,
} from "./events.js";

/** An event tagged with its append-only coordinates, for dedupe + ordering. */
export interface KeyedEvent extends AguiEvent {
  runId: string;
  seq: number;
}

/** A persisted event row as `GET .../history` and Realtime deliver it. */
export interface EventRow {
  type: EventType;
  data: Json | null;
  seq: number;
  run_id: string;
}

function key(runId: string, seq: number): string {
  return `${runId}#${seq}`;
}

/** Normalize history / Realtime rows (snake-case `run_id`) to `KeyedEvent`s. */
export function fromRows(rows: EventRow[]): KeyedEvent[] {
  return rows.map((r) => ({
    type: r.type,
    data: r.data,
    runId: r.run_id,
    seq: r.seq,
  }));
}

/**
 * Normalize the synchronous `POST /agui/run` response. Its events carry neither
 * `run_id` nor `seq` — but they're a single run's whole batch in emit order, and
 * `appendEvents` assigns `seq` as the per-run ordinal starting at 0, so the array
 * index *is* the seq. Tagging with the response `runId` lets these dedupe against
 * the same rows redelivered over Realtime.
 */
export function fromRunResponse(runId: string, events: AguiEvent[]): KeyedEvent[] {
  return events.map((e, seq) => ({ type: e.type, data: e.data, runId, seq }));
}

/**
 * An ordered, deduplicated event log. `add` is idempotent per `(runId, seq)`, so
 * replaying a run's events (run response, then Realtime) never double-applies.
 * `view()` folds the union into the renderable `ThreadView`.
 */
export class EventLog {
  private readonly byKey = new Map<string, KeyedEvent>();
  /** Run ids in first-seen order — the cross-run ordering, matching the server's
   *  `order by runs.started_at` history replay. */
  private readonly runOrder: string[] = [];

  /** Merge events in; returns true if any were new (the view changed). */
  add(events: KeyedEvent[]): boolean {
    let changed = false;
    for (const e of events) {
      const k = key(e.runId, e.seq);
      if (this.byKey.has(k)) continue;
      this.byKey.set(k, e);
      if (!this.runOrder.includes(e.runId)) this.runOrder.push(e.runId);
      changed = true;
    }
    return changed;
  }

  /** The reconciled log: ordered by run-first-seen, then per-run `seq`. */
  events(): KeyedEvent[] {
    const rank = new Map(this.runOrder.map((id, i) => [id, i]));
    return Array.from(this.byKey.values()).sort((a, b) => {
      const ra = rank.get(a.runId) ?? 0;
      const rb = rank.get(b.runId) ?? 0;
      return ra === rb ? a.seq - b.seq : ra - rb;
    });
  }

  /** Fold the reconciled log into the renderable view. */
  view(): ThreadView {
    return foldEvents(this.events());
  }
}
