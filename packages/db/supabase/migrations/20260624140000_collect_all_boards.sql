/**
* ENQUEUE EVERY BOARD ON THE DAILY COLLECT (ARC-140).
*
* The event engine's archer_cron_collect() (20260620180000_event_engine.sql) fired
* ONLY boards whose collect_status was 'integrated'. With all three seed boards still
* not_integrated, the daily run therefore did nothing at all — a not-integrated board
* was simply invisible.
*
* The owner wants every board to run on schedule and report its real state, with
* "not integrated" surfaced as a calm, expected OUTCOME rather than an absence. So the
* cron now enqueues a collect for EVERY board, ordered by slug. The CLI decides each
* board's terminal outcome: a NotIntegratedError now records a succeeded Activity
* tagged detail.outcome='not_integrated' (board status untouched) instead of a failed
* row that breaks the board — see services/cli/src/commands/collect.ts (runCollect).
*
* PORTABILITY: this only redefines a function body (no public table/enum change), so
* generated types are unaffected and the cron SCHEDULE itself is untouched. The body
* references public.archer_event_post (created by the engine migration, present on the
* type-gen Postgres too); check_function_bodies stays off to match the engine
* migration's lazy-planning posture for the net/vault-touching helper it calls.
*/
set check_function_bodies = off;

create or replace function public.archer_cron_collect()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  b record;
begin
  -- Every board, not just integrated ones (ARC-140): a not-integrated board still
  -- runs and reports "not integrated" as a clean, visible outcome — not a failure.
  for b in
    select slug from public.boards order by slug
  loop
    perform public.archer_event_post('/commands/collect/' || b.slug, '{}'::jsonb);
  end loop;
end;
$$;
