-- AUTONOMOUS COVER-LETTER GENERATION — the reactive half of the "no human click"
-- chain. When a candidacy enters `awaiting_cover_letter`, draft AND submit its
-- cover letter automatically so it surfaces ready for review on the frontend.
--
-- THE CHAIN: a company reaches `enriched` (archer_enriched_gate,
-- 20260625100000_enriched_candidacy_gate.sql) advances its shortlisted /
-- alternative_outreach candidacies to `awaiting_cover_letter` → THIS trigger fires
-- archer_event_post('/commands/cover-letter/'||id) over pg_net → the Hono service
-- endpoint drafts (Scribe) + submits a cover_letter_version proposal → the candidacy
-- lands at `in_review`, where the existing review/revise/approve loop takes over.
-- No operator click anywhere on that path.
--
-- This mirrors the event-engine's reactive triggers
-- (20260620180000_event_engine.sql: tg_candidacy_external_form / tg_activity_failed):
-- a status-edge guard (fire only on the transition INTO the state, not on every
-- update that leaves status untouched) POSTing through archer_event_post. That helper
-- reads the API base URL + shared secret from Supabase Vault and is a NO-OP-WITH-
-- WARNING when `archer_api_base_url` isn't set (e.g. the type-gen Postgres, or an
-- environment where the secret hasn't been provisioned) — it never raises into the
-- candidacy UPDATE that fired it, so a missing target can't block the status change.
--
-- Idempotent (create-or-replace / drop-if-exists) and forward-only: it only adds a
-- function + trigger (no table/column changes), so the generated TS types are
-- unchanged.

create or replace function public.archer_cover_letter_gate() returns trigger
  language plpgsql security definer set search_path = public, extensions as $fn$
begin
  if new.status = 'awaiting_cover_letter' and old.status is distinct from 'awaiting_cover_letter' then
    perform public.archer_event_post('/commands/cover-letter/' || new.id::text, '{}'::jsonb);
  end if;
  return new;
end $fn$;

drop trigger if exists archer_cover_letter_gate_trg on public.candidacies;
create trigger archer_cover_letter_gate_trg after update on public.candidacies
  for each row execute function public.archer_cover_letter_gate();
