-- The candidacy gate as a status-driven trigger: when a company reaches
-- `enriched`, advance its shortlisted / alternative_outreach candidacies to
-- `awaiting_cover_letter` and notify their owners.
--
-- This replaces the previously inline gate (in the CLI `runEnrich`), so the
-- hand-off fires regardless of who sets `enriched` — including the host
-- enrichment agent (claude -p + LinkedIn + Supabase MCP), which writes the
-- company row directly and never touches candidacies. See infra/enrichment/.

create or replace function public.archer_enriched_gate() returns trigger
  language plpgsql as $fn$
begin
  if new.status = 'enriched' and old.status is distinct from 'enriched' then
    with advanced as (
      update public.candidacies c
        set status = 'awaiting_cover_letter', status_changed_at = now(), updated_at = now()
        from public.postings p
        where c.posting_id = p.id and p.company_id = new.id
          and c.status in ('shortlisted', 'alternative_outreach')
        returning c.user_id, c.id, p.title
    )
    insert into public.notifications (user_id, kind, title, body, ref)
      select user_id, 'candidacy', 'A role is ready for your cover letter',
        coalesce(new.name, 'A company') || ' is researched — "' || title || '" is awaiting a cover letter.',
        jsonb_build_object('candidacyId', id, 'companyId', new.id, 'status', 'awaiting_cover_letter')
      from advanced;
  end if;
  return new;
end $fn$;

drop trigger if exists archer_enriched_gate_trg on public.companies;
create trigger archer_enriched_gate_trg
  after update on public.companies
  for each row execute function public.archer_enriched_gate();
