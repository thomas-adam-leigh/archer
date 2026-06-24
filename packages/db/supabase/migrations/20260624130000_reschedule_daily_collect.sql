/**
* RESCHEDULE THE DAILY COLLECT (ARC-138).
*
* The event engine (20260620180000_event_engine.sql) seeded the daily Collect at
* `0 13 * * 1-5` — 13:00 UTC, chosen as a placeholder. The owner wants the run to
* fire at the intended local time: ~11:00 SAST (UTC+2) = 09:00 UTC, on weekdays.
*
* CADENCE DECISION (recorded here per the issue): a SINGLE daily trigger that fans
* out internally — not staggered per-board cron entries. `archer_cron_collect()`
* stays the one entry point; the per-(board × title) fan-out and inter-attempt
* spacing land inside that path (ARC-139), keeping the schedule a one-liner. This
* is the simpler, recommended option from the daily-use roadmap design spec
* (docs/superpowers/specs/2026-06-24-archer-daily-use-roadmap-design.md).
*
* Only the `archer-collect-daily` schedule changes here; `archer-match-minute`
* (the per-minute matcher) is left untouched.
*
* PORTABILITY: pg_cron exists on Supabase but NOT on the vanilla postgres:17 the
* type generator runs migrations against (gen-types.sh). So the reschedule is
* guarded on pg_available_extensions exactly like the engine migration — it is a
* no-op on the type-gen Postgres, and this migration makes no `public`-schema
* change, so generated types are unaffected.
*/
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    -- Idempotent: only the daily collect is re-pointed; the matcher is left as-is.
    perform cron.unschedule(jobid) from cron.job where jobname = 'archer-collect-daily';
    -- 09:00 UTC = 11:00 SAST, weekdays. Internal fan-out happens in archer_cron_collect().
    perform cron.schedule('archer-collect-daily', '0 9 * * 1-5', 'select public.archer_cron_collect();');
  end if;
end
$$;
