#!/usr/bin/env bash
# Archer enrichment runner — finds companies that need enrichment (behind a
# shortlisted/alt-outreach job, still status=new) and enriches them via a
# claude -p agent using the LinkedIn + Supabase MCPs. The candidacy hand-off
# to awaiting_cover_letter is handled by a DB trigger (archer_enriched_gate),
# not here.
#
# DEPLOYED TO: n8n@computer:~/scripts/archer-enrich-runner.sh   (cron: 17,47 * * * *)
# Runs on the HOST (not the archer-api container) because the LinkedIn MCP is a
# patchright browser session with a long-lived login that lives on the host, and
# the API container has neither `claude` nor the MCPs. See README.md.
set -uo pipefail
LOG="$HOME/.cache/archer-enrich.log"
exec 9>"/tmp/archer-enrich.lock"
flock -n 9 || { echo "$(date -Is) skip: already running" >> "$LOG"; exit 0; }
echo "$(date -Is) === enrich run start ===" >> "$LOG"
/home/n8n/.local/bin/claude -p --dangerously-skip-permissions >> "$LOG" 2>&1 <<'PROMPT'
You are Archer's company-enrichment runner. Enrich companies that need it, in the Archer database (Supabase project `djyuqyiblzcsrqcirqgp`). Only write VERIFIED facts — NEVER fabricate an email or a LinkedIn URL.

## Find the work
Using the Supabase MCP on project `djyuqyiblzcsrqcirqgp`, run:
  select co.id, co.name from public.companies co
  where co.status='new'
    and exists (select 1 from public.candidacies c join public.postings p on p.id=c.posting_id
                where p.company_id=co.id and c.status in ('shortlisted','alternative_outreach'))
  order by co.created_at limit 3;
Those are companies behind a shortlisted/alt-outreach job that haven't been researched. If none, report "nothing to enrich" and STOP.

## For EACH company, one at a time
1. `update public.companies set status='researching', updated_at=now() where id='<id>';`
2. RESEARCH via the LinkedIn MCP (+ the company website): the website, a short factual description, the LinkedIn company URL/slug, a recruitment/careers email IF you genuinely find one, and 2-5 people who work there (prioritise recruiters / talent acquisition / hiring managers / engineering leads) — full name, role/title, LinkedIn profile URL. NEVER invent an email or a LinkedIn slug; if you can't find a person's exact LinkedIn URL, leave it null.
3. WRITE via Supabase MCP:
   - update public.companies set website_url, recruitment_email, description, linkedin_url, domain, enrichment = jsonb({summary, source:"linkedin_mcp"}), updated_at=now() where id='<id>' (set only fields you actually found).
   - insert public.contacts (company_id, full_name, email, linkedin_url, role_title) for each person; no duplicates.
4. FINISH: `update public.companies set status='enriched', updated_at=now() where id='<id>';`
5. On genuine failure (LinkedIn login expired / blocked / no data): `update public.companies set status='enrichment_failed', enrichment=jsonb_set(coalesce(enrichment,'{}'::jsonb),'{error}',to_jsonb('<short reason>'::text)), updated_at=now() where id='<id>';` then continue to the next.

## Rules
- Touch ONLY public.companies and public.contacts. Do NOT touch candidacies (a DB trigger advances them on enriched).
- Finish one company before starting the next. No fabrication.
- End with a SHORT report: per company — final status + number of contacts.
PROMPT
echo "$(date -Is) === enrich run end (exit $?) ===" >> "$LOG"
