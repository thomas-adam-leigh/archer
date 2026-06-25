#!/usr/bin/env bash
# Archer enrichment runner — enriches companies that need it via a claude -p agent
# (LinkedIn + Supabase MCPs). The candidacy hand-off to awaiting_cover_letter is a
# DB trigger (archer_enriched_gate), not here.
#
# DEPLOYED: n8n@computer:~/scripts/  (cron 17,47). Runs on the HOST, not the
# archer-api container (the LinkedIn browser session lives here; the container has
# no claude/MCPs). See README.md.
set -uo pipefail
# uv + claude live in ~/.local/bin, which a cron / non-login shell PATH lacks.
export PATH="$HOME/.local/bin:$PATH"
LOG="$HOME/.cache/archer-enrich.log"
exec 9>"/tmp/archer-enrich.lock"
flock -n 9 || { echo "$(date -Is) skip: already running" >> "$LOG"; exit 0; }

# --- Cheap pre-flight (NO LLM tokens) -------------------------------------------
# Only spin up the agent if a NEW company sits behind a shortlisted/alt-outreach
# candidacy. A plain psycopg query (via uv) against DATABASE_URL; ~0 cost. On any
# error or "no", we skip the agent (fail toward not wasting tokens).
set -a; . "$HOME/.archer-enrich.env"; set +a   # DATABASE_URL
HAS_WORK="$(uv run --no-project --quiet --with 'psycopg[binary]' python3 - <<'PY' 2>>"$LOG"
import os, psycopg
sql = ("select exists(select 1 from companies co where co.status='new' "
       "and exists(select 1 from candidacies c join postings p on p.id=c.posting_id "
       "where p.company_id=co.id and c.status in ('shortlisted','alternative_outreach')))")
with psycopg.connect(os.environ['DATABASE_URL']) as conn:
    print('yes' if conn.execute(sql).fetchone()[0] else 'no')
PY
)"
if [ "$HAS_WORK" != "yes" ]; then
  echo "$(date -Is) nothing to enrich (pre-flight='$HAS_WORK') — skip, no agent run" >> "$LOG"
  exit 0
fi
# -------------------------------------------------------------------------------

echo "$(date -Is) === enrich run start (work found) ===" >> "$LOG"
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
