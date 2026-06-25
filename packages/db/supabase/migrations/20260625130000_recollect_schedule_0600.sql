/**
* RETIME THE DAILY COLLECT TO 06:00 UTC (ARC-171).
*
* The declared collection schedule is now 08:00 SAST = 06:00 UTC on weekdays, aligned
* to the host collection runner's crontab (ARC-170) and served verbatim by the API as
* the dashboard's real "next run" (replacing the hardcoded fiction ARC-172 removes).
* This supersedes the 09:00 UTC placeholder from 20260624130000_reschedule_daily_collect.
*
* Only the `archer-collect-daily` schedule TIME changes; the body
* (`select public.archer_cron_collect();`) and `archer-match-minute` are left untouched.
*
* The served cron string lives in packages/db/src/collection-schedule.ts
* (COLLECTION_CRON); collection-schedule.test.ts asserts THIS migration schedules the
* same expression, so the API's reported schedule can't drift from the cron it runs.
*
* PORTABILITY: guarded on pg_cron (absent on the vanilla postgres the type generator
* runs against), and makes no public-schema change, so generated types are unaffected.
*/
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    -- Idempotent: only the daily collect is re-pointed; the matcher is left as-is.
    perform cron.unschedule(jobid) from cron.job where jobname = 'archer-collect-daily';
    -- 06:00 UTC = 08:00 SAST, weekdays. Internal fan-out happens in archer_cron_collect().
    perform cron.schedule('archer-collect-daily', '0 6 * * 1-5', 'select public.archer_cron_collect();');
  end if;
end
$$;
