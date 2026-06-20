/**
* ARCHER EVENT ENGINE — "the database moves on its own" (ARC-7).
*
* The control spine: state changes (not a central scheduler) drive the system.
* This migration installs the two halves of that spine on Supabase:
*
*   1. pg_cron schedules — a 13:00 weekday Collect and a per-minute Match. The
*      matcher is a no-op unless `new` candidacies exist, so the every-minute job
*      stays cheap.
*   2. Postgres triggers — a status-change trigger webhooks the Hono API when a
*      candidacy enters `external_pending` (the external-form fill path), and a
*      failed Activity webhooks the self-heal Mechanic. Both POST through one
*      pg_net helper that reads its target + shared secret from Supabase Vault.
*
* The API base URL + shared secret are NOT committed: they live in Vault under
* `archer_api_base_url` and `archer_api_secret` (set out-of-band per environment;
* see infra/komodo). The post helper is defensive — a missing secret or a failed
* HTTP enqueue logs a warning and returns, never aborting the DML that fired it.
*
* PORTABILITY: pg_cron and pg_net exist on Supabase but NOT on the vanilla
* postgres:17 the type generator applies migrations to (gen-types.sh). So every
* extension/cron statement is guarded on pg_available_extensions, and the helper
* functions are created with `check_function_bodies = off` so their references to
* the (absent) net/vault schemas don't fail at CREATE on the type-gen Postgres —
* their bodies are only ever planned when actually called, which never happens
* there. n8n is retired as an orchestrator (decision #3, Architecture doc).
*/

-- Let the helper functions reference net.* / vault.* even where those schemas do
-- not exist (the type-gen Postgres); bodies are planned lazily on first call.
set check_function_bodies = off;

-- ============================================================================
-- HTTP helper — POST a JSON payload to the Hono API over pg_net, authenticated
-- with the Vault-held shared secret. Returns the pg_net request id, or null when
-- it could not enqueue (so callers in triggers never roll back their DML).
-- ============================================================================
create or replace function public.archer_event_post(path text, payload jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base_url text;
  secret text;
  req_id bigint;
begin
  select decrypted_secret into base_url from vault.decrypted_secrets where name = 'archer_api_base_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'archer_api_secret';
  if base_url is null then
    raise warning 'archer_event_post: vault secret archer_api_base_url not set; skipping POST %', path;
    return null;
  end if;
  select net.http_post(
    url := base_url || path,
    body := payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-archer-secret', coalesce(secret, '')
    )
  ) into req_id;
  return req_id;
exception when others then
  raise warning 'archer_event_post: POST % failed: %', path, sqlerrm;
  return null;
end;
$$;

comment on function public.archer_event_post(text, jsonb) is
  'POST a JSON payload to the Hono API via pg_net, auth''d with the Vault shared secret. Defensive: never raises into the calling DML.';

-- ============================================================================
-- Cron bodies — the work each schedule runs. Kept as functions so the schedule
-- itself is a one-liner and the logic is testable/reviewable in one place.
-- ============================================================================

-- 13:00 weekday Collect: one Collect Activity per board whose collect adapter is
-- live (ARC-10 lifecycle). User defaults to ARCHER_USER_ID on the API side.
create or replace function public.archer_cron_collect()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  b record;
begin
  for b in
    select slug from public.boards where collect_status = 'integrated' order by slug
  loop
    perform public.archer_event_post('/commands/collect/' || b.slug, '{}'::jsonb);
  end loop;
end;
$$;

-- Per-minute Match: a no-op unless `new` candidacies exist, otherwise wakes the
-- Matchmaker once (it triages every `new` row in a single pass).
create or replace function public.archer_cron_match()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if exists (select 1 from public.candidacies where status = 'new') then
    perform public.archer_event_post('/commands/match', '{}'::jsonb);
  end if;
end;
$$;

-- ============================================================================
-- Triggers — the reactive half of the spine. Status changes webhook the API.
-- ============================================================================

-- A failed Activity wakes the self-heal Mechanic (/hooks/activity-failed).
create or replace function public.tg_activity_failed()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.status = 'failed' and old.status is distinct from 'failed' then
    perform public.archer_event_post(
      '/hooks/activity-failed',
      jsonb_build_object('type', 'activity-failed', 'record', to_jsonb(new))
    );
  end if;
  return new;
end;
$$;

-- A candidacy entering external_pending wakes the external-form fill path
-- (/hooks/external-form) — the redirect case from an Apply Activity.
create or replace function public.tg_candidacy_external_form()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.status = 'external_pending' and old.status is distinct from 'external_pending' then
    perform public.archer_event_post(
      '/hooks/external-form',
      jsonb_build_object('type', 'external-form', 'record', jsonb_build_object('id', new.id))
    );
  end if;
  return new;
end;
$$;

drop trigger if exists activity_failed_webhook on public.activities;
create trigger activity_failed_webhook
  after update on public.activities
  for each row execute function public.tg_activity_failed();

drop trigger if exists candidacy_external_form_webhook on public.candidacies;
create trigger candidacy_external_form_webhook
  after update on public.candidacies
  for each row execute function public.tg_candidacy_external_form();

-- ============================================================================
-- Extensions + schedules — Supabase only. Skipped on the type-gen Postgres,
-- which has neither pg_net nor pg_cron available.
-- NOTE: pg_cron fires in UTC. 13:00 here is 13:00 UTC; change to '0 11 * * 1-5'
-- if 13:00 SAST (UTC+2) is intended.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    execute 'create extension if not exists pg_net with schema extensions';
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron';
    -- Idempotent (re)schedule: drop any prior copies, then schedule afresh.
    perform cron.unschedule(jobid)
      from cron.job
      where jobname in ('archer-collect-daily', 'archer-match-minute');
    perform cron.schedule('archer-collect-daily', '0 13 * * 1-5', 'select public.archer_cron_collect();');
    perform cron.schedule('archer-match-minute', '* * * * *', 'select public.archer_cron_match();');
  end if;
end
$$;
